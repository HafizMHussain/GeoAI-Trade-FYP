import React, { useRef, useEffect } from 'react';

const MoonshotVideoSection = () => {
  const videoRef    = useRef(null);
  const watchdogRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    video.playbackRate = 1.0;

    const handleEnded = () => {
      video.currentTime = 0;
      video.play().catch(() => {});
    };

    const startWatchdog = () => {
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      watchdogRef.current = setInterval(() => {
        if (video && !video.paused && video.duration > 0 && video.currentTime === 0)
          video.play().catch(() => {});
      }, 1000);
    };

    const handleLoaded = () => { startWatchdog(); video.play().catch(() => {}); };

    video.addEventListener('ended',           handleEnded);
    video.addEventListener('loadedmetadata',  handleLoaded);
    if (video.readyState >= 2) handleLoaded();

    return () => {
      if (watchdogRef.current) clearInterval(watchdogRef.current);
      video.removeEventListener('ended',          handleEnded);
      video.removeEventListener('loadedmetadata', handleLoaded);
    };
  }, []);

  useEffect(() => {
    const resume = () => {
      const v = videoRef.current;
      if (v && v.paused) v.play().catch(() => {});
      document.removeEventListener('click', resume);
    };
    document.addEventListener('click', resume);
    return () => document.removeEventListener('click', resume);
  }, []);

  return (
    /* absolute — stays inside the hero section, never bleeds through below-fold content */
    <div className="absolute inset-0 z-0 overflow-hidden pointer-events-none">
      <div className="absolute inset-0 bg-geo-dark" />
      <video
        ref={videoRef}
        className="absolute inset-0 w-full h-full object-cover"
        src="/background_video.mp4"
        muted loop playsInline autoPlay preload="auto"
      />
    </div>
  );
};

export default MoonshotVideoSection;
