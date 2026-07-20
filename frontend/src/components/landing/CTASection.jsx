import React from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, ArrowRight, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';

const CTASection = () => (
  <section className="bg-gray-900 px-6 py-20">
    <div className="max-w-4xl mx-auto text-center">
      {/* Glow */}
      <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-geo-cyan/30 to-transparent" />

      <motion.div
        initial={{ opacity: 0, y: 24 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6 }}
      >
        <span className="inline-block px-3 py-1 rounded-full bg-geo-cyan/10 border border-geo-cyan/20 text-geo-cyan text-xs font-mono font-semibold uppercase tracking-wider mb-6">
          Get Started
        </span>

        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-5 leading-tight">
          Operationalize <span className="text-gradient">Risk-Aware</span> Logistics Decisions
        </h2>

        <p className="text-gray-400 text-lg mb-10 max-w-2xl mx-auto leading-relaxed">
          Transform Pakistan's port and supply chain risk management with real-time intelligence,
          predictive simulation, and AI-powered decision support.
        </p>

        <div className="flex flex-wrap justify-center gap-4 mb-8">
          <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
            <Link to="/map" className="inline-flex items-center gap-2.5 px-8 py-4 bg-gradient-to-r from-geo-cyan to-geo-teal text-gray-900 font-bold rounded-xl text-base hover:shadow-lg hover:shadow-geo-cyan/20 transition-all">
              Launch Dashboard
              <ExternalLink className="w-5 h-5" />
            </Link>
          </motion.div>
          <motion.div whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.96 }}>
            <Link to="/routes" className="inline-flex items-center gap-2.5 px-8 py-4 border border-white/20 text-white font-semibold rounded-xl text-base hover:bg-white/10 hover:border-white/40 transition-all">
              Plan a Safe Route
              <ArrowRight className="w-5 h-5" />
            </Link>
          </motion.div>
        </div>

        <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
          <Shield className="w-4 h-4 text-geo-cyan/60" />
          <span>Built for Pakistan FYP georesilience research · FastAPI + PostGIS + React</span>
        </div>
      </motion.div>
    </div>
  </section>
);

export default CTASection;
