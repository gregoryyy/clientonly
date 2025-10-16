// ELK.js + Cytoscape.js plain JS demo (100+ nodes)
(function () {
  const LAYERS = 12;         // number of layers
  const NODES_PER_LAYER = 10; // total nodes = 120
  const FAN_OUT = 2;          // avg edges per node to next layer

  const elk = new ELK();
  const cyContainer = document.getElementById('cy');
  const statNodes = document.getElementById('stat-nodes');
  const statEdges = document.getElementById('stat-edges');
  const statLayout = document.getElementById('stat-layout');
  const btnRegenerate = document.getElementById('btn-regenerate');
  const btnFit = document.getElementById('btn-fit');

  let seed = 1;
  let cy = null;

  function makeRng(seedInit) {
    let s = seedInit || 1;
    return function () {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5; // xorshift32
      return ((s >>> 0) % 100000) / 100000; // [0,1)
    };
  }

  function buildElkGraph(seedVal) {
    const nodes = [];
    const edges = [];
    const rnd = makeRng(seedVal);

    for (let layer = 0; layer < LAYERS; layer++) {
      for (let idx = 0; idx < NODES_PER_LAYER; idx++) {
        const id = `n_${layer}_${idx}`;
        nodes.push({ id, width: 120, height: 36, labels: [{ text: `T${layer}:${idx}` }] });
      }
    }

    for (let layer = 0; layer < LAYERS - 1; layer++) {
      for (let idx = 0; idx < NODES_PER_LAYER; idx++) {
        const src = `n_${layer}_${idx}`;
        const nextCount = Math.max(1, Math.round(FAN_OUT + (rnd() - 0.5))); // 1..3 typically
        for (let k = 0; k < nextCount; k++) {
          const tgtIdx = Math.floor(rnd() * NODES_PER_LAYER);
          const tgt = `n_${layer + 1}_${tgtIdx}`;
          edges.push({ id: `e_${layer}_${idx}_${k}_${tgtIdx}`, sources: [src], targets: [tgt] });
        }
      }
    }

    return {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "RIGHT",
        "elk.layered.spacing.nodeNodeBetweenLayers": "60",
        "elk.spacing.nodeNode": "24",
        "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
        "elk.layered.mergeEdges": "true",
      },
      children: nodes,
      edges,
    };
  }

  function elkToCytoscape(layouted) {
    const elements = [];

    (layouted.children || []).forEach((n) => {
      elements.push({
        data: { id: n.id, label: (n.labels && n.labels[0] && n.labels[0].text) || n.id },
        position: { x: n.x || 0, y: n.y || 0 },
      });
    });

    (layouted.edges || []).forEach((e) => {
      elements.push({ data: { id: e.id, source: e.sources[0], target: e.targets[0] } });
    });

    return elements;
  }

  function ensureCy(elements) {
    if (cy) {
      cy.destroy();
      cy = null;
    }
    cy = cytoscape({
      container: cyContainer,
      elements,
      layout: { name: 'preset', fit: true, padding: 30 },
      wheelSensitivity: 0.2,
      pixelRatio: 1,
      minZoom: 0.05,
      maxZoom: 3,
      style: [
        { selector: 'node', style: {
            width: 120,
            height: 36,
            shape: 'round-rectangle',
            'background-opacity': 0.12,
            'background-color': '#6b7280',
            'border-width': 1,
            'border-color': '#9ca3af',
            label: 'data(label)',
            color: '#111827',
            'font-size': 12,
            'text-wrap': 'wrap',
            'text-max-width': 110,
          }
        },
        { selector: 'edge', style: {
            width: 1.5,
            'curve-style': 'unbundled-bezier',
            'target-arrow-shape': 'triangle',
            'arrow-scale': 0.8,
            'line-color': '#9CA3AF',
            'target-arrow-color': '#9CA3AF',
          }
        },
        { selector: '.highlight', style: {
            'background-color': '#3b82f6',
            'border-color': '#2563eb',
            'line-color': '#60a5fa',
            'target-arrow-color': '#60a5fa',
            'transition-property': 'background-color, border-color, line-color, target-arrow-color',
            'transition-duration': 200,
          }
        },
        { selector: '.faded', style: { opacity: 0.15 } }
      ]
    });

    cy.on('mouseover', 'node', (evt) => {
      const node = evt.target;
      const neighborhood = node.closedNeighborhood();
      cy.elements().addClass('faded');
      neighborhood.removeClass('faded').addClass('highlight');
    });

    cy.on('mouseout', 'node', () => {
      cy.elements().removeClass('faded highlight');
    });

    cy.on('tap', 'node', (evt) => {
      cy.animate({ fit: { eles: evt.target, padding: 60 }, duration: 300 });
    });
  }

  async function render(seedVal) {
    const graph = buildElkGraph(seedVal);
    const t0 = performance.now();
    const layouted = await elk.layout(graph);
    const t1 = performance.now();
    const elements = elkToCytoscape(layouted);
    ensureCy(elements);

    statNodes.textContent = `Nodes: ${(layouted.children || []).length}`;
    statEdges.textContent = `Edges: ${(layouted.edges || []).length}`;
    statLayout.textContent = `ELK layout: ${Math.round(t1 - t0)} ms`;
  }

  btnRegenerate.addEventListener('click', () => { seed += 1; render(seed); });
  btnFit.addEventListener('click', () => { if (cy) cy.fit(undefined, 50); });

  // Initial render
  render(seed);
})();