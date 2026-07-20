import React from 'react';
import { motion } from 'framer-motion';
import { FileCode, ArrowDown, GitBranch, AlertCircle } from 'lucide-react';

const stages = [
  {
    name: 'network_model.py',
    description: 'Builds the multi-modal supply chain graph with nodes (ports, warehouses, cities) and weighted edges (roads, rail, sea corridors).',
    outputs: ['supply_chain_graph.gpkg', 'corridor_weights.csv'],
  },
  {
    name: 'hazard_model.py',
    description: 'Processes flood inundation maps, cyclone wind fields, and historical strike/accident data into spatial risk rasters.',
    outputs: ['flood_risk.tif', 'cyclone_risk.tif', 'strike_risk.gpkg'],
  },
  {
    name: 'risk_engine.py',
    description: 'Combines network topology with hazard layers to compute node vulnerability, edge disruption probability, and cascade effects.',
    outputs: ['node_risk_scores.json', 'edge_disruption_prob.csv'],
  },
  {
    name: 'ais_port_stress.py',
    description: 'Ingests real-time AIS vessel data, calculates berth occupancy, anchorage dwell times, and port congestion indices.',
    outputs: ['port_stress_index.json', 'vessel_queue.csv'],
  },
  {
    name: 'scenario_simulation.py',
    description: 'Runs Monte Carlo simulations across combined risk and AIS datasets to generate P10/P50/P90 supply chain impact forecasts.',
    outputs: ['monte_carlo_results.json', 'scenario_forecasts.csv'],
  },
];

const PipelineTimeline = () => (
  <section id="pipeline" className="relative z-10 section-padding py-24 bg-geo-navy">
    <div className="max-w-5xl mx-auto">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: '-100px' }}
        transition={{ duration: 0.6 }}
        className="text-center mb-16"
      >
        <span className="inline-block px-4 py-1.5 rounded-full bg-geo-orange/10 border border-geo-orange/20 text-geo-orange text-sm font-mono mb-4">
          DATA PIPELINE
        </span>
        <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-white mb-4">
          Processing <span className="text-gradient">Pipeline</span>
        </h2>
        <p className="text-gray-400 text-lg max-w-2xl mx-auto">
          Five mandatory stages executed in sequence. Downstream stages depend on prior outputs.
        </p>
      </motion.div>

      <div className="relative">
        <div className="absolute left-6 sm:left-8 top-0 bottom-0 w-[2px] bg-gradient-to-b from-geo-cyan via-geo-teal to-geo-orange opacity-30" />
        <div className="space-y-8">
          {stages.map((stage, index) => (
            <motion.div
              key={stage.name}
              initial={{ opacity: 0, x: -30 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true, margin: '-50px' }}
              transition={{ duration: 0.5, delay: index * 0.1 }}
              className="relative flex gap-6"
            >
              <div className="relative flex-shrink-0">
                <motion.div
                  className="w-12 h-12 sm:w-16 sm:h-16 rounded-xl bg-geo-navy border-2 border-geo-cyan/30 flex items-center justify-center relative z-10"
                  whileHover={{ scale: 1.1 }}
                >
                  <span className="text-lg font-bold text-geo-cyan font-mono">{index + 1}</span>
                </motion.div>
                {index < stages.length - 1 && (
                  <motion.div
                    className="absolute top-12 sm:top-16 left-1/2 -translate-x-1/2"
                    animate={{ y: [0, 5, 0] }}
                    transition={{ duration: 2, repeat: Infinity, delay: index * 0.3 }}
                  >
                    <ArrowDown className="w-5 h-5 text-geo-cyan/50" />
                  </motion.div>
                )}
              </div>

              <div className="flex-1 glass-panel p-5 sm:p-6 hover:border-geo-cyan/20 transition-all">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <FileCode className="w-5 h-5 text-geo-cyan flex-shrink-0" />
                    <h3 className="text-lg font-semibold text-white font-mono">{stage.name}</h3>
                  </div>
                  <span className="px-2 py-1 rounded-md bg-geo-teal/10 text-geo-teal text-xs font-mono flex items-center gap-1">
                    <GitBranch className="w-3 h-3" />v1.0
                  </span>
                </div>
                <p className="text-gray-400 text-sm mb-4 leading-relaxed">{stage.description}</p>
                <div className="flex flex-wrap gap-2">
                  {stage.outputs.map(output => (
                    <span key={output} className="px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-xs text-gray-400 font-mono">
                      {output}
                    </span>
                  ))}
                </div>
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        className="mt-12 flex items-center justify-center gap-3 px-6 py-4 rounded-xl bg-geo-orange/5 border border-geo-orange/20"
      >
        <AlertCircle className="w-5 h-5 text-geo-orange flex-shrink-0" />
        <p className="text-sm text-gray-300">
          <span className="text-geo-orange font-semibold">Note:</span> Downstream stages depend on prior outputs.
          The pipeline enforces sequential execution with dependency validation.
        </p>
      </motion.div>
    </div>
  </section>
);

export default PipelineTimeline;
