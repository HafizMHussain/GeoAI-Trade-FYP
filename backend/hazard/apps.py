"""
Hazard app config — auto-schedules the full analytics pipeline every 15 minutes.

Schedule:
  T+0  : hazard_model.py   (live hazard scoring from GDACS, Open-Meteo, RSS NLP)
  T+finish+30s : risk_engine.py (UNDRR risk = hazard × exposure × vulnerability)

Both results are written to PostGIS tables by the scripts themselves.
"""

import os
import sys
import threading
import subprocess
import time
import logging
from datetime import datetime, timezone
from django.apps import AppConfig

logger = logging.getLogger(__name__)

_scheduler_started = False

# ── Pipeline state (shared with hazard_run GET endpoint) ──────────────────────
_pipeline_running = False
_pipeline_lock = threading.Lock()


def _parse_pipeline_ts(ts_str):
    s = str(ts_str).strip()
    try:
        if len(s) >= 13 and '_' in s:
            return datetime(
                int(s[0:4]), int(s[4:6]), int(s[6:8]),
                int(s[9:11]), int(s[11:13]), 0, tzinfo=timezone.utc,
            )
        return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)
    except Exception:
        return None


def _minutes_since_last_hazard_run():
    try:
        from django.db import connection
        with connection.cursor() as c:
            c.execute("SELECT MAX(timestamp) FROM public.kpis_log")
            row = c.fetchone()
        ts = row[0] if row and row[0] else None
        if not ts:
            return None
        dt = _parse_pipeline_ts(ts)
        if dt is None:
            return None
        return (datetime.now(timezone.utc) - dt).total_seconds() / 60
    except Exception:
        return None


def _spawn_script(script_name: str) -> 'subprocess.Popen | None':
    """Spawn a pipeline script and return its process, or None on error."""
    try:
        from django.conf import settings
        repo_root = str(settings.BASE_DIR.parent)
        script = os.path.join(repo_root, 'pipelines', script_name)
        if not os.path.exists(script):
            logger.warning('[Pipeline] %s not found at %s', script_name, script)
            return None
        log_dir = os.path.join(repo_root, 'backend', 'outputs')
        os.makedirs(log_dir, exist_ok=True)
        ts = int(time.time())
        log_path = os.path.join(log_dir, f'{script_name.replace(".py", "")}_{ts}.log')
        with open(log_path, 'w', encoding='utf-8') as log_f:
            proc = subprocess.Popen(
                [sys.executable, script],
                cwd=repo_root,
                stdout=log_f,
                stderr=subprocess.STDOUT,
            )
        logger.info('[Pipeline] %s started (pid=%d) → %s', script_name, proc.pid, log_path)
        return proc
    except Exception as exc:
        logger.exception('[Pipeline] Failed to start %s: %s', script_name, exc)
        return None


def _run_full_pipeline():
    """
    Run hazard_model.py, wait for it to finish, then run risk_engine.py.
    If hazard takes >20 min, proceed anyway (risk engine uses latest DB state).
    Sets _pipeline_running so the status endpoint can report it.
    """
    global _pipeline_running
    with _pipeline_lock:
        if _pipeline_running:
            logger.info('[Pipeline] Already running — skipping this trigger')
            return
        _pipeline_running = True

    try:
        logger.info('[Pipeline] ═══ Starting full pipeline run ═══')

        logger.info('[Pipeline] Step 1/2: hazard_model.py')
        proc = _spawn_script('hazard_model.py')

        if proc is not None:
            try:
                # Wait up to 20 minutes for hazard to finish
                proc.wait(timeout=1200)
                rc = proc.returncode
                logger.info('[Pipeline] hazard_model.py finished (rc=%d)', rc)
            except subprocess.TimeoutExpired:
                logger.warning('[Pipeline] hazard_model.py timed out after 20 min — continuing to risk engine')

        # Brief pause so DB writes from hazard settle
        time.sleep(30)

        logger.info('[Pipeline] Step 2/2: risk_engine.py')
        rproc = _spawn_script('risk_engine.py')
        if rproc is not None:
            try:
                rproc.wait(timeout=1200)
                logger.info('[Pipeline] risk_engine.py finished (rc=%d)', rproc.returncode)
            except subprocess.TimeoutExpired:
                logger.warning('[Pipeline] risk_engine.py timed out after 20 min')

        logger.info('[Pipeline] ═══ Pipeline run complete ═══')
    except Exception as exc:
        logger.exception('[Pipeline] Unexpected error during pipeline run: %s', exc)
    finally:
        with _pipeline_lock:
            _pipeline_running = False


def is_pipeline_running() -> bool:
    """Public accessor for other modules (e.g. api_views.hazard_run)."""
    with _pipeline_lock:
        return _pipeline_running


def _scheduler_loop():
    """
    Fixed-interval scheduler: runs the full pipeline exactly every 15 minutes.

    Logic:
    - On startup, wait 30s for Django ORM to be ready, then immediately check
      if a run is due (last run > 15 min ago OR no previous run).
    - After each pipeline execution, sleep exactly 15 minutes before the
      next run, regardless of how long the pipeline took.
    - Between runs, check every 60s whether the schedule has drifted (e.g.
      if the server was restarted) and trigger immediately if overdue.
    """
    PIPELINE_INTERVAL_SEC = 15 * 60   # 15 minutes
    CHECK_INTERVAL_SEC = 60           # Check every 60 seconds
    RUN_AFTER_MIN = 15                # Trigger threshold in minutes

    # Wait for Django ORM to be fully ready (shorter than before)
    time.sleep(30)
    logger.info('[AutoScheduler] ✓ Active — pipeline scheduled every %d minutes', RUN_AFTER_MIN)

    while True:
        try:
            mins = _minutes_since_last_hazard_run()

            if mins is None or mins >= RUN_AFTER_MIN:
                logger.info(
                    '[AutoScheduler] Pipeline is DUE (last run: %s min ago) — triggering now',
                    f'{mins:.1f}' if mins is not None else 'never'
                )
                _run_full_pipeline()

                # After a successful run, sleep the full interval before checking again.
                # This prevents double-triggering if the pipeline finishes fast.
                logger.info('[AutoScheduler] Next run in %d minutes', RUN_AFTER_MIN)
                time.sleep(PIPELINE_INTERVAL_SEC)
            else:
                remaining = RUN_AFTER_MIN - mins
                logger.debug(
                    '[AutoScheduler] Not due yet (%.1f / %d min, %.1f min remaining)',
                    mins, RUN_AFTER_MIN, remaining
                )
                # Sleep the shorter of: remaining time or check interval
                sleep_sec = min(remaining * 60, CHECK_INTERVAL_SEC)
                time.sleep(max(sleep_sec, 10))  # at least 10s to avoid tight loops

        except Exception as exc:
            logger.exception('[AutoScheduler] Unexpected error: %s', exc)
            time.sleep(CHECK_INTERVAL_SEC)  # back off on error


class HazardConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'hazard'
    verbose_name = 'Hazard Engine'

    def ready(self):
        global _scheduler_started
        if _scheduler_started:
            return

        # Only auto-start in the live server process (not migrations, shell, tests)
        running_server = any(cmd in sys.argv for cmd in ('runserver', 'gunicorn', 'uvicorn'))
        if not running_server:
            return

        _scheduler_started = True
        t = threading.Thread(target=_scheduler_loop, name='PipelineAutoScheduler', daemon=True)
        t.start()
        logger.info('[HazardConfig] Pipeline auto-scheduler thread launched')
