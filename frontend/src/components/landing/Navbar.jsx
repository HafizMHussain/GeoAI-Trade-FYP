import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu, X, ExternalLink, ChevronRight, Zap } from 'lucide-react';
import { Link } from 'react-router-dom';

const NAV_LINKS = [
  { name: 'Live Data',    href: '#network-status' },
  { name: 'Features',    href: '#features' },
  { name: 'Modules',     href: '#modules' },
  { name: 'AI Demo',     href: '#ai-assistant' },
];

const Navbar = ({ tickerVisible = false }) => {
  const [scrolled,   setScrolled]   = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollTo = (href) => {
    document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
    setMobileOpen(false);
  };

  return (
    <>
      <motion.nav
        initial={{ opacity: 0, y: -16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
        className={`fixed left-0 right-0 z-50 transition-all duration-300 ${
          tickerVisible ? 'top-9' : 'top-0'
        }`}
      >
        {/* Glass bar — only shows bg after scrolling */}
        <div className={`transition-all duration-300 ${
          scrolled
            ? 'bg-gray-950/85 backdrop-blur-2xl border-b border-white/8 shadow-2xl shadow-black/40'
            : 'bg-transparent'
        }`}>
          <div className="max-w-7xl mx-auto px-5 sm:px-8 lg:px-10">
            <div className="flex items-center justify-between h-[64px]">

              {/* ── Logo ── */}
              <motion.a
                href="#"
                onClick={e => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}
                className="flex items-center gap-2.5 flex-shrink-0 group"
                whileHover={{ scale: 1.02 }}
                whileTap={{ scale: 0.97 }}
              >
                {/* Icon mark */}
                <div className="relative w-8 h-8 flex-shrink-0">
                  <div className="absolute inset-0 rounded-lg bg-gradient-to-br from-geo-cyan to-geo-teal opacity-90" />
                  <div className="absolute inset-0 rounded-lg ring-1 ring-white/20" />
                  <Zap className="absolute inset-0 m-auto w-4 h-4 text-gray-950" />
                </div>
                {/* Wordmark */}
                <div className="leading-none">
                  <div className="text-[15px] font-extrabold text-white tracking-tight">GEOAI</div>
                  <div className="text-[9px] font-semibold text-geo-cyan/70 tracking-[0.18em] uppercase mt-0.5">TRADE</div>
                </div>
              </motion.a>

              {/* ── Desktop nav links ── */}
              <div className="hidden lg:flex items-center gap-0.5">
                {NAV_LINKS.map(link => (
                  <button
                    key={link.name}
                    onClick={() => scrollTo(link.href)}
                    className="relative px-4 py-2 text-sm font-medium text-white/65 hover:text-white transition-colors duration-200 rounded-lg hover:bg-white/6 group"
                  >
                    {link.name}
                    {/* Underline reveal on hover */}
                    <span className="absolute bottom-1.5 left-4 right-4 h-[1.5px] bg-geo-cyan scale-x-0 group-hover:scale-x-100 transition-transform duration-250 origin-left rounded-full" />
                  </button>
                ))}
              </div>

              {/* ── Desktop CTA ── */}
              <div className="hidden lg:flex items-center gap-3">
                <Link
                  to="/routes"
                  className="px-4 py-2 text-sm font-semibold text-white/70 hover:text-white border border-white/15 hover:border-white/35 rounded-lg transition-all duration-200 hover:bg-white/6"
                >
                  Plan Route
                </Link>
                <Link
                  to="/map"
                  className="flex items-center gap-1.5 px-5 py-2 bg-gradient-to-r from-geo-cyan to-geo-teal text-gray-950 font-bold text-sm rounded-lg hover:brightness-110 hover:shadow-lg hover:shadow-geo-cyan/25 transition-all duration-200"
                >
                  Launch Dashboard
                  <ExternalLink className="w-3.5 h-3.5" />
                </Link>
              </div>

              {/* ── Mobile hamburger ── */}
              <button
                className="lg:hidden p-2 text-white/80 hover:text-white transition-colors"
                onClick={() => setMobileOpen(v => !v)}
                aria-label="Toggle menu"
              >
                <motion.div
                  animate={{ rotate: mobileOpen ? 90 : 0 }}
                  transition={{ duration: 0.2 }}
                >
                  {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
                </motion.div>
              </button>

            </div>
          </div>
        </div>
      </motion.nav>

      {/* ── Mobile drawer ── */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
            className={`fixed left-3 right-3 z-40 ${tickerVisible ? 'top-[100px]' : 'top-[72px]'}`}
          >
            <div className="bg-gray-950/95 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-2xl overflow-hidden">
              <div className="p-3 space-y-0.5">
                {NAV_LINKS.map(link => (
                  <button
                    key={link.name}
                    onClick={() => scrollTo(link.href)}
                    className="w-full flex items-center justify-between px-4 py-3 text-sm text-white/70 hover:text-white hover:bg-white/6 rounded-xl transition-all"
                  >
                    <span className="font-medium">{link.name}</span>
                    <ChevronRight className="w-4 h-4 opacity-40" />
                  </button>
                ))}
              </div>

              {/* Divider */}
              <div className="mx-3 border-t border-white/8" />

              {/* Mobile CTAs */}
              <div className="p-3 space-y-2">
                <Link
                  to="/routes"
                  onClick={() => setMobileOpen(false)}
                  className="block w-full text-center py-2.5 text-sm font-semibold text-white/70 border border-white/15 rounded-xl hover:bg-white/6 transition-all"
                >
                  Plan a Safe Route
                </Link>
                <Link
                  to="/map"
                  onClick={() => setMobileOpen(false)}
                  className="block w-full text-center py-3 text-sm font-bold bg-gradient-to-r from-geo-cyan to-geo-teal text-gray-950 rounded-xl hover:brightness-110 transition-all"
                >
                  Launch Dashboard
                </Link>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};

export default Navbar;
