import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, ExternalLink } from 'lucide-react';
import { Link } from 'react-router-dom';

const Hero = () => {
  const item = {
    hidden:  { opacity: 0, y: 24 },
    visible: { opacity: 1, y: 0, transition: { duration: 0.65, ease: [0.25, 0.46, 0.45, 0.94] } },
  };

  return (
    <section className="relative flex items-center min-h-screen px-5 sm:px-8 lg:px-10 pt-24 pb-16">
      <div className="relative z-10 w-full max-w-7xl mx-auto">
        <div className="max-w-3xl">
          <motion.div
            variants={{ hidden: { opacity: 1 }, visible: { opacity: 1, transition: { staggerChildren: 0.14, delayChildren: 0.2 } } }}
            initial="hidden"
            animate="visible"
          >
            {/* Live badge */}
            <motion.div variants={item}>
              <span className="inline-flex items-center gap-2 bg-white/10 backdrop-blur-sm border border-white/20 rounded-full px-4 py-1.5 text-xs font-mono text-white/80 mb-7">
                <span className="w-1.5 h-1.5 rounded-full bg-teal-400 animate-pulse" />
                Real-time Geospatial Risk Intelligence Platform
              </span>
            </motion.div>

            {/* Headline */}
            <motion.h1
              variants={item}
              className="text-4xl sm:text-5xl lg:text-6xl xl:text-[4.25rem] font-extrabold text-white leading-[1.08] mb-6 tracking-tight text-gradient"
            >
              GEOAI TRADE
            </motion.h1>

            {/* Sub */}
            <motion.p
              variants={item}
              className="text-base sm:text-lg text-white/70 mb-10 max-w-xl leading-relaxed"
            >
              Multi-hazard risk assessment fused with real-time AIS port monitoring,
              Monte Carlo scenario simulation, and AI-powered risk Q&amp;A for Pakistan's
              critical maritime infrastructure.
            </motion.p>

            {/* CTAs */}
            <motion.div variants={item} className="flex flex-wrap gap-3 mb-12">
              <Link
                to="/map"
                className="inline-flex items-center gap-2.5 px-7 py-3.5 bg-gradient-to-r from-geo-cyan to-geo-teal text-gray-900 font-bold rounded-xl text-sm hover:shadow-lg hover:shadow-geo-cyan/25 hover:scale-[1.02] transition-all duration-200"
              >
                Launch Dashboard
                <ExternalLink className="w-4 h-4" />
              </Link>
              <button
                onClick={() => document.querySelector('#network-status')?.scrollIntoView({ behavior: 'smooth' })}
                className="inline-flex items-center gap-2.5 px-7 py-3.5 bg-white/10 backdrop-blur-sm border border-white/20 text-white font-semibold rounded-xl text-sm hover:bg-white/20 hover:border-white/40 transition-all duration-200"
              >
                View Live Data
                <ArrowRight className="w-4 h-4" />
              </button>
            </motion.div>

            {/* Trust indicators */}
            <motion.div variants={item} className="flex flex-wrap items-center gap-5">
              {[
                { dot: 'bg-teal-400',   label: 'FastAPI + PostGIS' },
                { dot: 'bg-cyan-400',   label: 'Real-time AIS' },
                { dot: 'bg-orange-400', label: 'Monte Carlo Sim' },
              ].map(({ dot, label }) => (
                <div key={label} className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
                  <span className="text-sm text-white/50 font-medium">{label}</span>
                </div>
              ))}
            </motion.div>
          </motion.div>
        </div>
      </div>
    </section>
  );
};

export default Hero;
