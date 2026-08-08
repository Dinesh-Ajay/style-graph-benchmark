/**
 * public/js/charts.js
 *
 * Dashboard chart handling for the Style Graph Benchmark.
 *
 * Reads the ACTUAL benchmark result structure:
 *
 * ingestion:
 *   {
 *     skipped,
 *     nodesPerSecond,
 *     relationshipsPerSecond,
 *     seconds
 *   }
 *
 * traversals:
 *   {
 *     oneHop:   { p50Ms, p95Ms },
 *     twoHop:   { p50Ms, p95Ms },
 *     threeHop: { p50Ms, p95Ms }
 *   }
 *
 * lookups:
 *   {
 *     point:    { p50Ms, p95Ms },
 *     filtered: { p50Ms, p95Ms }
 *   }
 *
 * aggregation:
 *   {
 *     p50Ms,
 *     p95Ms
 *   }
 *
 * mixed:
 *   {
 *     qps,
 *     operations,
 *     seconds,
 *     clients,
 *     writeRatio
 *   }
 */

/* ============================================================
   PLATFORM METADATA
   ============================================================ */

export const PLATFORMS = [
  {
    id: 'cognodb',
    label: 'CognoDB',
    color: '#a78bfa'
  },
  {
    id: 'neo4j',
    label: 'Neo4j AuraDB',
    color: '#4c8dff'
  },
  {
    id: 'memgraph',
    label: 'Memgraph',
    color: '#ff7a59'
  },
  {
    id: 'arangodb',
    label: 'ArangoDB',
    color: '#34d399'
  }
];

const KNOWN_PLATFORM_IDS = PLATFORMS.map((p) => p.id);


/* ============================================================
   METRIC DEFINITIONS
   ============================================================ */

export const METRIC_DEFINITIONS = [
  {
    key: 'ingestion',
    label: 'Ingestion Throughput',
    unit: 'ops/sec',
    better: 'higher'
  },
  {
    key: 'mixed',
    label: 'Mixed Workload QPS',
    unit: 'ops/sec',
    better: 'higher'
  },
  {
    key: 'traversal',
    label: 'Traversal Latency',
    unit: 'ms',
    better: 'lower'
  },
  {
    key: 'lookup',
    label: 'Lookup Latency',
    unit: 'ms',
    better: 'lower'
  },
  {
    key: 'aggregation',
    label: 'Aggregation Latency',
    unit: 'ms',
    better: 'lower'
  }
];


/* ============================================================
   HELPERS
   ============================================================ */

function normalizeKey(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}


function normalizePlatformId(raw) {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  const key = normalizeKey(raw);

  if (key.includes('cogno')) {
    return 'cognodb';
  }

  if (key.includes('neo4j') || key.includes('aura')) {
    return 'neo4j';
  }

  if (key.includes('memgraph')) {
    return 'memgraph';
  }

  if (key.includes('arango')) {
    return 'arangodb';
  }

  return KNOWN_PLATFORM_IDS.includes(key)
    ? key
    : null;
}


function isObject(value) {
  return value !== null && typeof value === 'object';
}


function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : null;
}


/* ============================================================
   EXTRACT PLATFORM RESULTS
   ============================================================ */

function extractPlatformEntries(raw) {
  const entries = new Map();

  if (!isObject(raw)) {
    return entries;
  }

  /*
   * Handle:
   *
   * {
   *   platforms: {
   *      cognodb: {...},
   *      neo4j: {...}
   *   }
   * }
   */

  let container = raw;

  if (isObject(raw.platforms)) {
    container = raw.platforms;
  } else if (isObject(raw.results)) {
    container = raw.results;
  }

  /*
   * Handle an array:
   *
   * [
   *   { platform: "cognodb", ... },
   *   { platform: "neo4j", ... }
   * ]
   */

  if (Array.isArray(container)) {
    for (const item of container) {
      if (!isObject(item)) {
        continue;
      }

      const rawPlatform =
        item.platform ||
        item.platformKey ||
        item.id ||
        item.name ||
        item.key;

      const platformId = normalizePlatformId(rawPlatform);

      if (platformId) {
        entries.set(platformId, item);
      }
    }

    return entries;
  }

  /*
   * Handle:
   *
   * {
   *   cognodb: {...},
   *   neo4j: {...}
   * }
   */

  if (isObject(container)) {
    for (const [key, value] of Object.entries(container)) {
      if (!isObject(value)) {
        continue;
      }

      const platformId =
        normalizePlatformId(key) ||
        normalizePlatformId(
          value.platform ||
          value.platformKey ||
          value.name
        );

      if (platformId) {
        entries.set(platformId, value);
      }
    }
  }

  /*
   * Handle a single-platform result:
   *
   * {
   *   platform: "cognodb",
   *   ...
   * }
   */

  if (entries.size === 0 && raw.platform) {
    const platformId = normalizePlatformId(raw.platform);

    if (platformId) {
      entries.set(platformId, raw);
    }
  }

  return entries;
}


/* ============================================================
   NORMALIZATION
   ============================================================ */

export function normalizeResults(raw) {
  const entries = extractPlatformEntries(raw);

  const ingestion = {};
  const mixed = {};
  const traversal = {};
  const lookup = {};
  const aggregation = {};

  for (const [platformId, result] of entries) {

    /* --------------------------------------------------------
       INGESTION
       -------------------------------------------------------- */

    if (isObject(result.ingestion)) {

      if (!result.ingestion.skipped) {
        const nodesPerSecond =
          numberOrNull(result.ingestion.nodesPerSecond);

        if (nodesPerSecond !== null) {
          ingestion[platformId] = nodesPerSecond;
        }
      }
    }


    /* --------------------------------------------------------
       MIXED WORKLOAD
       -------------------------------------------------------- */

    if (isObject(result.mixed)) {

      const qps = numberOrNull(result.mixed.qps);

      if (qps !== null) {
        mixed[platformId] = qps;
      }
    }


    /* --------------------------------------------------------
       TRAVERSAL
       -------------------------------------------------------- */

    if (isObject(result.traversals)) {

      /*
       * We use 1-Hop p50 as the main value for the
       * general Traversal Comparison chart.
       */

      const oneHop = result.traversals.oneHop;

      if (isObject(oneHop)) {
        const value = numberOrNull(oneHop.p50Ms);

        if (value !== null) {
          traversal[platformId] = value;
        }
      }
    }


    /* --------------------------------------------------------
       LOOKUP
       -------------------------------------------------------- */

    if (isObject(result.lookups)) {

      /*
       * We use Point Lookup p50 as the main value for the
       * general Lookup Comparison chart.
       */

      const point = result.lookups.point;

      if (isObject(point)) {
        const value = numberOrNull(point.p50Ms);

        if (value !== null) {
          lookup[platformId] = value;
        }
      }
    }


    /* --------------------------------------------------------
       AGGREGATION
       -------------------------------------------------------- */

    if (isObject(result.aggregation)) {

      const value = numberOrNull(result.aggregation.p50Ms);

      if (value !== null) {
        aggregation[platformId] = value;
      }
    }
  }


  const platforms = KNOWN_PLATFORM_IDS.filter(
    (id) => entries.has(id)
  );


  return {
    platforms,

    metrics: {
      ingestion: {
        label: 'Ingestion Throughput',
        unit: 'ops/sec',
        better: 'higher',
        values: ingestion
      },

      mixed: {
        label: 'Mixed Workload QPS',
        unit: 'ops/sec',
        better: 'higher',
        values: mixed
      },

      traversal: {
        label: 'Traversal Latency',
        unit: 'ms',
        better: 'lower',
        values: traversal
      },

      lookup: {
        label: 'Lookup Latency',
        unit: 'ms',
        better: 'lower',
        values: lookup
      },

      aggregation: {
        label: 'Aggregation Latency',
        unit: 'ms',
        better: 'lower',
        values: aggregation
      }
    },

    /*
     * Keep the original raw platform entries.
     * The detailed charts below use this directly.
     */

    rawEntries: entries
  };
}


/* ============================================================
   PLATFORM DISPLAY
   ============================================================ */

export function platformMeta(id) {
  return PLATFORMS.find((p) => p.id === id) || {
    id,
    label: id,
    color: '#8a93a6'
  };
}


/* ============================================================
   CHART STATE
   ============================================================ */

let chartInstances = {};

let defaultsConfigured = false;


/* ============================================================
   CHART DEFAULTS
   ============================================================ */

function configureChartDefaults() {

  if (
    defaultsConfigured ||
    typeof Chart === 'undefined'
  ) {
    return;
  }

  Chart.defaults.color = '#aab3c5';

  Chart.defaults.font.family =
    "'Inter', sans-serif";

  Chart.defaults.font.size = 12;

  Chart.defaults.plugins.legend.labels.usePointStyle = true;

  Chart.defaults.plugins.legend.labels.boxWidth = 8;

  defaultsConfigured = true;
}


/* ============================================================
   COMMON CHART OPTIONS
   ============================================================ */

function baseOptions({
  yAxisLabel,
  unit,
  showLegend = false
}) {

  return {
    responsive: true,

    maintainAspectRatio: false,

    animation: {
      duration: 650,
      easing: 'easeOutCubic'
    },

    plugins: {

      legend: {
        display: showLegend,
        position: 'bottom'
      },

      tooltip: {
        mode: 'index',
        intersect: false,

        callbacks: {

          label: (ctx) =>
            `${ctx.dataset.label}: ${ctx.formattedValue} ${unit}`

        }
      }
    },

    scales: {

      x: {
        ticks: {
          color: '#aab3c5'
        },

        grid: {
          display: false
        }
      },

      y: {

        beginAtZero: true,

        ticks: {
          color: '#aab3c5'
        },

        grid: {
          color: 'rgba(255,255,255,0.07)'
        },

        title: {
          display: true,
          text: yAxisLabel,
          color: '#aab3c5'
        }
      }
    }
  };
}


/* ============================================================
   SINGLE DATASET BAR CHART
   ============================================================ */

function buildSingleMetricChart(
  canvasId,
  metric,
  platforms
) {

  const canvas =
    document.getElementById(canvasId);

  if (!canvas || platforms.length === 0) {
    return null;
  }

  const labels = platforms.map(
    (id) => platformMeta(id).label
  );

  const colors = platforms.map(
    (id) => platformMeta(id).color
  );

  const data = platforms.map(
    (id) =>
      metric.values[id] !== undefined
        ? metric.values[id]
        : null
  );


  return new Chart(canvas, {

    type: 'bar',

    data: {

      labels,

      datasets: [{
        label: metric.label,

        data,

        backgroundColor: colors,

        borderRadius: 6,

        borderSkipped: false,

        maxBarThickness: 56
      }]
    },

    options: baseOptions({
      yAxisLabel:
        `${metric.label} (${metric.unit})`,

      unit: metric.unit,

      showLegend: false
    })
  });
}


/* ============================================================
   TRAVERSAL DETAIL CHART
   ============================================================ */

function buildTraversalChart(
  canvasId,
  normalized,
  platforms
) {

  const canvas =
    document.getElementById(canvasId);

  if (!canvas || platforms.length === 0) {
    return null;
  }


  const labels = platforms.map(
    (id) => platformMeta(id).label
  );


  const datasets = [
    {
      label: '1-Hop p50',
      backgroundColor: '#4c8dff'
    },
    {
      label: '2-Hop p50',
      backgroundColor: '#c084fc'
    },
    {
      label: '3-Hop p50',
      backgroundColor: '#fb923c'
    }
  ];


  const values = datasets.map(
    () => []
  );


  for (const platformId of platforms) {

    const result =
      normalized.rawEntries.get(platformId);

    const traversals =
      result && result.traversals;

    values[0].push(
      traversals &&
      traversals.oneHop
        ? numberOrNull(
            traversals.oneHop.p50Ms
          )
        : null
    );

    values[1].push(
      traversals &&
      traversals.twoHop
        ? numberOrNull(
            traversals.twoHop.p50Ms
          )
        : null
    );

    values[2].push(
      traversals &&
      traversals.threeHop
        ? numberOrNull(
            traversals.threeHop.p50Ms
          )
        : null
    );
  }


  datasets.forEach(
    (dataset, index) => {

      dataset.data = values[index];

      dataset.borderRadius = 6;

      dataset.borderSkipped = false;

      dataset.maxBarThickness = 28;
    }
  );


  return new Chart(canvas, {

    type: 'bar',

    data: {
      labels,
      datasets
    },

    options: baseOptions({
      yAxisLabel: 'Traversal Latency (ms)',
      unit: 'ms',
      showLegend: true
    })
  });
}


/* ============================================================
   LOOKUP DETAIL CHART
   ============================================================ */

function buildLookupChart(
  canvasId,
  normalized,
  platforms
) {

  const canvas =
    document.getElementById(canvasId);

  if (!canvas || platforms.length === 0) {
    return null;
  }


  const labels = platforms.map(
    (id) => platformMeta(id).label
  );


  const pointData = [];
  const filteredData = [];


  for (const platformId of platforms) {

    const result =
      normalized.rawEntries.get(platformId);

    const lookups =
      result && result.lookups;


    pointData.push(
      lookups &&
      lookups.point
        ? numberOrNull(
            lookups.point.p50Ms
          )
        : null
    );


    filteredData.push(
      lookups &&
      lookups.filtered
        ? numberOrNull(
            lookups.filtered.p50Ms
          )
        : null
    );
  }


  return new Chart(canvas, {

    type: 'bar',

    data: {

      labels,

      datasets: [

        {
          label: 'Point Lookup p50',

          data: pointData,

          backgroundColor: '#4c8dff',

          borderRadius: 6,

          borderSkipped: false,

          maxBarThickness: 32
        },

        {
          label: 'Filtered Lookup p50',

          data: filteredData,

          backgroundColor: '#c084fc',

          borderRadius: 6,

          borderSkipped: false,

          maxBarThickness: 32
        }

      ]
    },

    options: baseOptions({
      yAxisLabel: 'Lookup Latency (ms)',
      unit: 'ms',
      showLegend: true
    })
  });
}


/* ============================================================
   DESTROY EXISTING CHARTS
   ============================================================ */

export function destroyCharts() {

  for (const chart of Object.values(chartInstances)) {

    if (chart) {
      chart.destroy();
    }
  }

  chartInstances = {};
}


/* ============================================================
   RENDER ALL FIVE CHARTS
   ============================================================ */

export function renderCharts(normalized) {

  configureChartDefaults();

  destroyCharts();


  const {
    platforms,
    metrics
  } = normalized;


  if (platforms.length === 0) {
    return;
  }


  /*
   * QPS:
   *
   * Prefer ingestion throughput when available.
   * Otherwise use Mixed Workload QPS.
   *
   * This means RESET_DATABASE=false will still
   * produce a useful QPS chart.
   */

  const ingestionValues =
    metrics.ingestion.values;

  const hasIngestion =
    Object.keys(ingestionValues).length > 0;


  const qpsMetric = hasIngestion
    ? metrics.ingestion
    : metrics.mixed;


  chartInstances.qps =
    buildSingleMetricChart(
      'chart-qps',
      qpsMetric,
      platforms
    );


  /*
   * Traversal:
   *
   * Main comparison uses 1-Hop p50.
   * Detailed chart shows 1/2/3-Hop p50.
   */

  chartInstances.traversal =
    buildTraversalChart(
      'chart-traversal',
      normalized,
      platforms
    );


  /*
   * Lookup:
   *
   * Shows Point and Filtered p50.
   */

  chartInstances.lookup =
    buildLookupChart(
      'chart-lookup',
      normalized,
      platforms
    );


  /*
   * Aggregation:
   *
   * Uses aggregation p50.
   */

  chartInstances.aggregation =
    buildSingleMetricChart(
      'chart-aggregation',
      metrics.aggregation,
      platforms
    );


  /*
   * Overall latency comparison:
   *
   * Traversal = 1-Hop p50
   * Lookup = Point Lookup p50
   * Aggregation = Aggregation p50
   */

  chartInstances.latency =
    buildLatencyComparisonChart(
      'chart-latency',
      normalized,
      platforms
    );
}


/* ============================================================
   OVERALL LATENCY COMPARISON
   ============================================================ */

function buildLatencyComparisonChart(
  canvasId,
  normalized,
  platforms
) {

  const canvas =
    document.getElementById(canvasId);

  if (!canvas || platforms.length === 0) {
    return null;
  }


  const labels = platforms.map(
    (id) => platformMeta(id).label
  );


  const traversalData =
    platforms.map(
      (id) =>
        normalized.metrics.traversal.values[id] ??
        null
    );


  const lookupData =
    platforms.map(
      (id) =>
        normalized.metrics.lookup.values[id] ??
        null
    );


  const aggregationData =
    platforms.map(
      (id) =>
        normalized.metrics.aggregation.values[id] ??
        null
    );


  return new Chart(canvas, {

    type: 'bar',

    data: {

      labels,

      datasets: [

        {
          label: 'Traversal',
          backgroundColor: '#4c8dff',
          data: traversalData,
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 28
        },

        {
          label: 'Lookup',
          backgroundColor: '#c084fc',
          data: lookupData,
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 28
        },

        {
          label: 'Aggregation',
          backgroundColor: '#fb923c',
          data: aggregationData,
          borderRadius: 6,
          borderSkipped: false,
          maxBarThickness: 28
        }

      ]
    },

    options: baseOptions({
      yAxisLabel: 'Latency (ms)',
      unit: 'ms',
      showLegend: true
    })
  });
}