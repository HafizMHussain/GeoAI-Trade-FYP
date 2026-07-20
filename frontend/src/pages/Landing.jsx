import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { networkApi, hazardApi, riskApi } from '../api/networkApi';

import MoonshotVideoSection  from '../components/landing/MoonshotVideoSection';
import Navbar                from '../components/landing/Navbar';
import Hero                  from '../components/landing/Hero';
import NetworkStatusSection  from '../components/landing/NetworkStatusSection';
import ModulesGrid           from '../components/landing/ModulesGrid';
import WhyPlatform           from '../components/landing/WhyPlatform';
import LLMSection            from '../components/landing/LLMSection';
import LiveMetricsSection    from '../components/landing/LiveMetricsSection';
import CTASection            from '../components/landing/CTASection';
import Footer                from '../components/landing/Footer';

// ── Scrolling alert ticker (fixed, sits above the navbar) ─────────────────────
function CriticalTicker({ hazSum, counts }) {
  if (!counts || (counts.CRITICAL || 0) === 0) return null;
  const text = `🔴 ACTIVE FLOOD ALERT — ${counts.CRITICAL} trade locations at critical risk · ${hazSum?.flood?.triggered || 0} locations affected · ${Math.round((hazSum?.flood?.max_score || 0) * 100)}% flood intensity · ${counts.HIGH || 0} additional locations at high risk`;
  return (
    <div className="fixed top-0 left-0 right-0 z-[70] bg-red-600 text-white overflow-hidden py-2">
      <div className="relative h-5 overflow-hidden">
        <div className="ticker-run absolute text-sm font-bold px-4">
          {text}<span className="mx-16 opacity-40">◆</span>{text}
        </div>
      </div>
    </div>
  );
}

export default function Landing() {
  const { data: hazSum }   = useQuery({ queryKey: ['hazard-summary'],    queryFn: () => hazardApi.getSummary().then(r => r.data),        refetchInterval: 30000 });
  const { data: metrics }  = useQuery({ queryKey: ['network-metrics'],   queryFn: () => networkApi.getMetrics().then(r => r.data),       staleTime: 300000 });
  const { data: riskDist } = useQuery({ queryKey: ['risk-distribution'], queryFn: () => riskApi.getDistribution().then(r => r.data),    refetchInterval: 120000 });

  const counts      = hazSum?.alert_counts || {};
  const hasCritical = (counts.CRITICAL || 0) > 0;

  return (
    <div className="bg-geo-dark text-gray-100" style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>

      {/* Ticker: z-70 so it clears the navbar (z-50) */}
      <CriticalTicker hazSum={hazSum} counts={counts} />

      {/* ── Hero — video is absolute so it never bleeds below this section ─── */}
      <div className="relative min-h-screen overflow-hidden">

        {/* Video (absolute, clipped by overflow-hidden) */}
        <MoonshotVideoSection />

        {/* Gradient overlays for text contrast */}
        <div className="absolute inset-0 z-[2] pointer-events-none">
          <div className="absolute inset-0 bg-gradient-to-b from-black/60 via-black/40 to-black/80" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/55 via-black/20 to-transparent" />
        </div>

        {/* Navbar + content */}
        <div className="absolute inset-0 z-10 flex flex-col">
          {/* Navbar knows about the ticker to offset itself */}
          <Navbar tickerVisible={hasCritical} />

          <div className="flex-1">
            <Hero />
          </div>
        </div>
      </div>

      {/* ── All below-fold sections have solid bg — video never shows ────── */}
      <div className="relative z-10">
        <NetworkStatusSection metrics={metrics} hazSum={hazSum} riskDist={riskDist} />
      </div>

      <div className="relative z-10">
        <ModulesGrid />
        <WhyPlatform />
        <LLMSection />
        <LiveMetricsSection />
      </div>

      <div className="relative z-10">
        <CTASection />
        <Footer />
      </div>
    </div>
  );
}
