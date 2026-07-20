import React from 'react';
import { motion } from 'framer-motion';
import { Globe, Github, Mail, Linkedin, ExternalLink } from 'lucide-react';

const quickLinks = [
  { name: 'Features',     href: '#features' },
  { name: 'Modules',      href: '#modules' },
  { name: 'AI Assistant', href: '#ai-assistant' },
  { name: 'Architecture', href: '#architecture' },
];

const resources = [
  { name: 'Documentation',    href: '#' },
  { name: 'API Reference',    href: '#' },
  { name: 'GitHub Repository', href: '#' },
  { name: 'Research Paper',   href: '#' },
];

const Footer = () => {
  const scrollTo = (href) => {
    if (href.startsWith('#')) document.querySelector(href)?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <footer id="contact" className="relative z-10 border-t border-white/10 bg-geo-navy">
      <div className="section-padding py-16">
        <div className="max-w-7xl mx-auto">
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-12 mb-12">
            {/* Brand */}
            <div className="sm:col-span-2 lg:col-span-1">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-lg bg-gradient-to-br from-geo-cyan to-geo-teal flex items-center justify-center">
                  <Globe className="w-5 h-5 text-geo-dark" />
                </div>
                <div>
                  <span className="text-lg font-bold text-white">GeoResilience</span>
                  <span className="block text-[10px] text-geo-cyan/70 font-mono tracking-widest uppercase">Pakistan</span>
                </div>
              </div>
              <p className="text-sm text-gray-500 mb-6 leading-relaxed">
                Geospatial Risk Intelligence Platform for Pakistan's Ports &amp; Supply Chains. FYP Research Project.
              </p>
              <div className="flex gap-3">
                {[Github, Mail, Linkedin].map((Icon, i) => (
                  <motion.a
                    key={i}
                    href="#"
                    whileHover={{ scale: 1.1, y: -2 }}
                    whileTap={{ scale: 0.95 }}
                    className="w-9 h-9 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center hover:border-geo-cyan/30 hover:bg-geo-cyan/10 transition-all"
                  >
                    <Icon className="w-4 h-4 text-gray-400" />
                  </motion.a>
                ))}
              </div>
            </div>

            {/* Quick Links */}
            <div>
              <h4 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Platform</h4>
              <ul className="space-y-3">
                {quickLinks.map(link => (
                  <li key={link.name}>
                    <button onClick={() => scrollTo(link.href)} className="text-sm text-gray-500 hover:text-geo-cyan transition-colors">
                      {link.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>

            {/* Resources */}
            <div>
              <h4 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Resources</h4>
              <ul className="space-y-3">
                {resources.map(link => (
                  <li key={link.name}>
                    <a href={link.href} className="text-sm text-gray-500 hover:text-geo-cyan transition-colors flex items-center gap-1">
                      {link.name}
                      <ExternalLink className="w-3 h-3 opacity-50" />
                    </a>
                  </li>
                ))}
              </ul>
            </div>

            {/* Contact */}
            <div>
              <h4 className="text-sm font-semibold text-white uppercase tracking-wider mb-4">Contact</h4>
              <ul className="space-y-3 text-sm text-gray-500">
                <li className="flex items-center gap-2">
                  <Mail className="w-4 h-4 text-geo-cyan/50" />
                  <span>research@georesilience.pk</span>
                </li>
                <li><span>Department of Geospatial Engineering</span></li>
                <li><span>Final Year Project — Pakistan</span></li>
              </ul>
            </div>
          </div>

          <div className="pt-8 border-t border-white/5 flex flex-col sm:flex-row justify-between items-center gap-4">
            <p className="text-xs text-gray-600">© {new Date().getFullYear()} GeoResilience Pakistan. Built for FYP georesilience research.</p>
            <div className="flex gap-6 text-xs text-gray-600">
              <span>Privacy Policy</span>
              <span>Terms of Use</span>
              <span>Research Ethics</span>
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;
