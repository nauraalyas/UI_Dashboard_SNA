/* ==========================================================================
   SNA Fakultas UI — app.js
   Membaca data hasil preprocessing (data/*.json) dan tidak melakukan
   perhitungan/agregasi manual di luar apa yang tersedia pada file data.
   ========================================================================== */

const STATE = {
  faculties: [],          // faculties.json
  facultyById: new Map(), // faculty_id -> faculty
  facultyByFacId: new Map(), // "FAC_XXX" -> faculty
  nodesMeta: [],           // nodes.json (faculty/account/link nodes)
  facultyNodeMeta: new Map(), // "FAC_XXX" -> node metrics (mentions/contents/accounts)
  edgesSharedAccountProjection: [],
  edgesSharedLinkProjection: [],
  edgesSharedAccount: [],   // faculty-account bipartite (for connection detail)
  edgesSharedLink: [],      // faculty-link bipartite (for connection detail)
  metrics: null,
  validation: null,

  monitoringData: [],      // monitoring.json (raw rows from monitoring_clean.xlsx)
  dateMin: null, dateMax: null, // bounds available in monitoring data (YYYY-MM-DD)
  dateFrom: null, dateTo: null, // active global period filter
  globalFaculty: "",        // active global faculty filter ("" = semua fakultas)

  mode: "shared_account",  // shared_account | shared_link
  minWeight: 1,
  facultyFilter: new Set(),// selected faculty initials (empty = all)
  searchTerm: "",

  selectedNode: null,      // faculty initials
  selectedEdge: null,      // {a, b}

  // graph render helpers
  simulation: null,
  svg: null, zoomG: null, zoomBehavior: null,
};

const FAC_ID_PREFIX = "FAC_";

function facIdToInitials(facId) {
  return facId.replace(FAC_ID_PREFIX, "");
}

/* -------------------------------------------------------------------------
   DATA LOADING
   ------------------------------------------------------------------------- */
async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Gagal memuat ${path}: ${res.status}`);
  return res.json();
}

async function loadAllData() {
  const [
    faculties, nodesMeta,
    edgesSAProj, edgesSLProj,
    edgesSA, edgesSL,
    metrics, validation,
    monitoringData
  ] = await Promise.all([
    loadJSON("data/faculties.json"),
    loadJSON("data/nodes.json"),
    loadJSON("data/edges_shared_account_projection.json"),
    loadJSON("data/edges_shared_link_projection.json"),
    loadJSON("data/edges_shared_account.json"),
    loadJSON("data/edges_shared_link.json"),
    loadJSON("data/metrics.json"),
    loadJSON("data/validation_report.json"),
    loadJSON("data/monitoring.json"),
  ]);

  STATE.faculties = faculties;
  faculties.forEach(f => {
    STATE.facultyById.set(f.faculty_id, f);
    STATE.facultyByFacId.set(`${FAC_ID_PREFIX}${f.faculty_initials}`, f);
  });

  STATE.nodesMeta = nodesMeta;
  nodesMeta.filter(n => n.type === "faculty").forEach(n => {
    STATE.facultyNodeMeta.set(n.id, n.metrics || {});
  });

  STATE.edgesSharedAccountProjection = edgesSAProj;
  STATE.edgesSharedLinkProjection = edgesSLProj;
  STATE.edgesSharedAccount = edgesSA;
  STATE.edgesSharedLink = edgesSL;
  STATE.metrics = metrics;
  STATE.validation = validation;

  STATE.monitoringData = monitoringData.filter(r => r.date_iso);
  const dates = STATE.monitoringData.map(r => r.date_iso).sort();
  STATE.dateMin = dates[0];
  STATE.dateMax = dates[dates.length - 1];
  STATE.dateFrom = STATE.dateMin;
  STATE.dateTo = STATE.dateMax;
}

/* -------------------------------------------------------------------------
   DERIVED HELPERS
   ------------------------------------------------------------------------- */
function activeProjectionEdges() {
  return STATE.mode === "shared_account"
    ? STATE.edgesSharedAccountProjection
    : STATE.edgesSharedLinkProjection;
}

function activeBipartiteEdges() {
  return STATE.mode === "shared_account"
    ? STATE.edgesSharedAccount
    : STATE.edgesSharedLink;
}

// Faculty initials list actually present in faculties.json, in display_order
function allFacultyInitials() {
  return [...STATE.faculties]
    .sort((a, b) => a.display_order - b.display_order)
    .map(f => f.faculty_initials);
}

// Apply current filters (mode is separate; this filters an edge list)
function filteredEdges() {
  const edges = activeProjectionEdges();
  const facFilterActive = STATE.facultyFilter.size > 0;
  return edges.filter(e => {
    if (e.weight < STATE.minWeight) return false;
    if (facFilterActive) {
      const a = facIdToInitials(e.source);
      const b = facIdToInitials(e.target);
      if (!STATE.facultyFilter.has(a) && !STATE.facultyFilter.has(b)) return false;
    }
    return true;
  });
}

// Nodes that appear in filtered edges (plus, if a faculty filter is set,
// always include the selected faculties themselves even if isolated)
function filteredNodeInitials(edges) {
  const set = new Set();
  edges.forEach(e => {
    set.add(facIdToInitials(e.source));
    set.add(facIdToInitials(e.target));
  });
  if (STATE.facultyFilter.size > 0) {
    STATE.facultyFilter.forEach(f => set.add(f));
  } else if (edges.length === 0 && STATE.facultyFilter.size === 0) {
    // no filter, no edges pass threshold: show nothing (empty state)
  }
  return set;
}

function degreeMaps(edges) {
  const degree = new Map();
  const weightedDegree = new Map();
  edges.forEach(e => {
    const a = facIdToInitials(e.source);
    const b = facIdToInitials(e.target);
    degree.set(a, (degree.get(a) || 0) + 1);
    degree.set(b, (degree.get(b) || 0) + 1);
    weightedDegree.set(a, (weightedDegree.get(a) || 0) + e.weight);
    weightedDegree.set(b, (weightedDegree.get(b) || 0) + e.weight);
  });
  return { degree, weightedDegree };
}

/* -------------------------------------------------------------------------
   CENTRALITY (unweighted shortest paths on the active/filtered graph)
   ------------------------------------------------------------------------- */
function computeCentralities(nodeList, edges) {
  const n = nodeList.length;
  const idx = new Map(nodeList.map((f, i) => [f, i]));
  const adj = Array.from({ length: n }, () => []);
  edges.forEach(e => {
    const a = idx.get(facIdToInitials(e.source));
    const b = idx.get(facIdToInitials(e.target));
    if (a === undefined || b === undefined) return;
    adj[a].push(b);
    adj[b].push(a);
  });

  const degreeCentrality = new Array(n).fill(0);
  adj.forEach((neighbors, i) => { degreeCentrality[i] = n > 1 ? neighbors.length / (n - 1) : 0; });

  // Brandes' algorithm for betweenness + BFS distances for closeness
  const betweenness = new Array(n).fill(0);
  const closenessRaw = new Array(n).fill(0);

  for (let s = 0; s < n; s++) {
    const stack = [];
    const preds = Array.from({ length: n }, () => []);
    const sigma = new Array(n).fill(0); sigma[s] = 1;
    const dist = new Array(n).fill(-1); dist[s] = 0;
    const queue = [s];
    let qi = 0;
    while (qi < queue.length) {
      const v = queue[qi++];
      stack.push(v);
      adj[v].forEach(w => {
        if (dist[w] < 0) { dist[w] = dist[v] + 1; queue.push(w); }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; preds[w].push(v); }
      });
    }
    const reachable = dist.filter(d => d > 0);
    if (reachable.length > 0) {
      closenessRaw[s] = reachable.reduce((a, b) => a + b, 0);
    }
    const delta = new Array(n).fill(0);
    while (stack.length) {
      const w = stack.pop();
      preds[w].forEach(v => {
        delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      });
      if (w !== s) betweenness[w] += delta[w];
    }
  }
  // undirected graph: divide by 2
  for (let i = 0; i < n; i++) betweenness[i] /= 2;
  // normalize betweenness by (n-1)(n-2)/2
  const normFactor = n > 2 ? ((n - 1) * (n - 2)) / 2 : 1;
  const betweennessNorm = betweenness.map(v => normFactor > 0 ? v / normFactor : 0);

  const closeness = closenessRaw.map((sum, i) => {
    const reachableCount = adj.length > 0 ? dfsReachableCount(adj, i) : 0;
    if (sum === 0) return 0;
    return (reachableCount - 1) / sum;
  });

  const result = new Map();
  nodeList.forEach((f, i) => {
    result.set(f, {
      degreeCentrality: degreeCentrality[i],
      betweenness: betweennessNorm[i],
      closeness: closeness[i],
    });
  });
  return result;
}

function dfsReachableCount(adj, start) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const v = stack.pop();
    adj[v].forEach(w => { if (!seen.has(w)) { seen.add(w); stack.push(w); } });
  }
  return seen.size;
}

/* -------------------------------------------------------------------------
   KPI / METRICS / VALIDATION RENDER
   ------------------------------------------------------------------------- */
function renderKPIs() {
  const m = STATE.metrics;
  document.getElementById("kpiRecords").textContent = fmt(m.total_records);
  document.getElementById("kpiContents").textContent = fmt(m.unique_contents);
  document.getElementById("kpiAccounts").textContent = fmt(m.unique_accounts);
  document.getElementById("kpiFaculties").textContent = fmt(m.unique_faculties);
  document.getElementById("kpiSharedAccountEdges").textContent = fmt(STATE.edgesSharedAccountProjection.length);
  document.getElementById("kpiSharedLinkEdges").textContent = fmt(STATE.edgesSharedLinkProjection.length);
}

function renderValidation() {
  const v = STATE.validation;
  const items = [
    { ok: true, text: `${fmt(v.deduped_rows)} records processed` },
    { ok: true, text: `${fmt(v.unique_faculties_mapped)} faculties mapped` },
    { ok: v.missing_faculty_rows === 0, text: v.missing_faculty_rows === 0 ? "No missing faculty" : `${v.missing_faculty_rows} missing faculty rows` },
    { ok: v.missing_account_rows === 0, text: v.missing_account_rows === 0 ? "No missing account" : `${v.missing_account_rows} missing account rows` },
    { ok: v.missing_link_rows === 0, text: v.missing_link_rows === 0 ? "No missing link" : `${v.missing_link_rows} missing link rows` },
    { ok: v.invalid_date_rows === 0, text: v.invalid_date_rows === 0 ? "No invalid dates" : `${v.invalid_date_rows} invalid dates` },
  ];
  const grid = document.getElementById("validationGrid");
  grid.innerHTML = items.map(it => `
    <div class="validation-item ${it.ok ? "" : "fail"}">
      <span>${it.ok ? "✓" : "✕"}</span><span>${it.text}</span>
    </div>`).join("");

  const allOk = items.every(it => it.ok);
  const badge = document.getElementById("validationBadge");
  badge.textContent = allOk ? "✓ Data tervalidasi" : "⚠ Ada isu validasi";
  badge.className = "badge " + (allOk ? "badge-green" : "badge-amber");

  document.getElementById("methRecords").textContent = fmt(STATE.metrics.total_records);
  document.getElementById("methFaculties").textContent = fmt(STATE.metrics.unique_faculties);
  document.getElementById("methAccounts").textContent = fmt(STATE.metrics.unique_accounts);
  document.getElementById("methContents").textContent = fmt(STATE.metrics.unique_contents);
}

function fmt(n) {
  if (n === undefined || n === null) return "–";
  return Number(n).toLocaleString("id-ID");
}

// Compact number format, Indonesian style: 1.234 -> "1,2 K", 3.8e9 -> "3,8 M"
function fmtCompact(n) {
  if (n === undefined || n === null || isNaN(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(".", ",") + " M";
  if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(".", ",") + " Jt";
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(".", ",") + " K";
  return fmt(Math.round(n));
}

/* -------------------------------------------------------------------------
   MONITORING DATA (monitoring_clean.xlsx) — Executive Summary & Detail Panel
   ------------------------------------------------------------------------- */
function monitoringRows({ faculty = null, dateFrom = STATE.dateFrom, dateTo = STATE.dateTo } = {}) {
  return STATE.monitoringData.filter(r => {
    if (r.date_iso < dateFrom || r.date_iso > dateTo) return false;
    if (faculty && r.faculty_initials !== faculty) return false;
    return true;
  });
}

function summarizeMonitoringRows(rows) {
  const totalMentions = rows.length;
  const engagement = rows.reduce((a, r) => a + (r.engagement || 0), 0);
  const reach = rows.reduce((a, r) => a + (r.reach || 0), 0);
  const pos = rows.filter(r => r.sentiment === "pos").length;
  const net = rows.filter(r => r.sentiment === "net").length;
  const neg = rows.filter(r => r.sentiment === "neg").length;
  const posPct = totalMentions > 0 ? (pos / totalMentions) * 100 : 0;
  return { totalMentions, engagement, reach, pos, net, neg, posPct };
}

function renderExecutiveSummary() {
  const faculty = STATE.globalFaculty || null;
  const rows = monitoringRows({ faculty });
  const s = summarizeMonitoringRows(rows);

  document.getElementById("execTotalMentions").textContent = fmt(s.totalMentions);
  document.getElementById("execEngagement").textContent = fmtCompact(s.engagement);
  document.getElementById("execReach").textContent = fmtCompact(s.reach);
  document.getElementById("execSentimentPos").textContent = s.totalMentions > 0 ? `${s.posPct.toFixed(0)}%` : "–";

  const allOk = STATE.validation && STATE.validation.missing_faculty_rows === 0
    && STATE.validation.missing_account_rows === 0
    && STATE.validation.missing_link_rows === 0
    && STATE.validation.invalid_date_rows === 0;
  const statusEl = document.getElementById("execStatus");
  statusEl.textContent = allOk ? "Terkendali" : "Perlu Cek";
  statusEl.style.color = allOk ? "var(--green)" : "var(--amber)";

  const facLabel = faculty ? faculty : "Semua Fakultas";
  const fromLabel = formatDateID(STATE.dateFrom);
  const toLabel = formatDateID(STATE.dateTo);
  const periodLabel = STATE.dateFrom === STATE.dateTo ? fromLabel : `${fromLabel} – ${toLabel}`;
  document.getElementById("execSummarySubtitle").textContent = `${facLabel} • ${periodLabel} • dihitung dari ${fmt(s.totalMentions)} baris monitoring_clean.xlsx`;
}

function formatDateID(iso) {
  if (!iso) return "–";
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

/* -------------------------------------------------------------------------
   FILTER CONTROLS SETUP
   ------------------------------------------------------------------------- */
function setupFilterControls() {
  const facultySelect = document.getElementById("facultySelect");
  facultySelect.innerHTML = allFacultyInitials().map(init => {
    const fac = [...STATE.facultyById.values()].find(f => f.faculty_initials === init);
    return `<option value="${init}">${init} — ${fac ? fac.faculty_name : ""}</option>`;
  }).join("");
  facultySelect.addEventListener("change", () => {
    STATE.facultyFilter = new Set([...facultySelect.selectedOptions].map(o => o.value));
    renderAll();
  });

  const weightSlider = document.getElementById("weightSlider");
  const weightVal = document.getElementById("weightSliderValue");
  // set slider max based on max weight in both modes
  const maxW = Math.max(
    ...STATE.edgesSharedAccountProjection.map(e => e.weight),
    ...STATE.edgesSharedLinkProjection.map(e => e.weight),
    1
  );
  weightSlider.max = Math.min(maxW, 30);
  weightSlider.addEventListener("input", () => {
    STATE.minWeight = Number(weightSlider.value);
    weightVal.textContent = STATE.minWeight + (Number(weightSlider.value) >= Number(weightSlider.max) ? "+" : "");
    renderAll();
  });

  document.getElementById("searchBox").addEventListener("input", (e) => {
    STATE.searchTerm = e.target.value.trim().toUpperCase();
    highlightSearch();
  });

  document.getElementById("resetFiltersBtn").addEventListener("click", () => {
    STATE.facultyFilter = new Set();
    STATE.minWeight = 1;
    STATE.searchTerm = "";
    facultySelect.selectedOptions && [...facultySelect.options].forEach(o => o.selected = false);
    weightSlider.value = 1;
    weightVal.textContent = "1";
    document.getElementById("searchBox").value = "";
    renderAll();
  });

  document.querySelectorAll(".mode-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".mode-tab").forEach(b => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      STATE.mode = btn.dataset.mode;
      STATE.selectedNode = null;
      STATE.selectedEdge = null;
      document.getElementById("networkModeDesc").textContent = STATE.mode === "shared_account"
        ? "Fakultas terhubung jika memiliki akun monitoring yang sama."
        : "Fakultas terhubung jika memiliki URL/konten yang sama.";
      showDetailEmpty();
      renderAll();
    });
  });
}

/* -------------------------------------------------------------------------
   TOPBAR CONTROLS (periode & fakultas — kanan atas)
   ------------------------------------------------------------------------- */
function setupTopbarControls() {
  const dateFrom = document.getElementById("dateFrom");
  const dateTo = document.getElementById("dateTo");
  [dateFrom, dateTo].forEach(inp => { inp.min = STATE.dateMin; inp.max = STATE.dateMax; });
  dateFrom.value = STATE.dateFrom;
  dateTo.value = STATE.dateTo;

  function applyDateChange() {
    let from = dateFrom.value || STATE.dateMin;
    let to = dateTo.value || STATE.dateMax;
    if (from > to) { [from, to] = [to, from]; dateFrom.value = from; dateTo.value = to; }
    STATE.dateFrom = from;
    STATE.dateTo = to;
    renderExecutiveSummary();
    if (STATE.selectedNode) renderDetailFaculty(STATE.selectedNode);
  }
  dateFrom.addEventListener("change", applyDateChange);
  dateTo.addEventListener("change", applyDateChange);

  const globalFacultySelect = document.getElementById("globalFacultySelect");
  globalFacultySelect.innerHTML = `<option value="">Semua Fakultas</option>` +
    allFacultyInitials().map(init => `<option value="${init}">${init}</option>`).join("");
  globalFacultySelect.addEventListener("change", () => {
    const val = globalFacultySelect.value;
    STATE.globalFaculty = val;
    renderExecutiveSummary();
    if (val) {
      selectFacultyNode(val, { skipSync: true });
    } else {
      STATE.selectedNode = null;
      STATE.selectedEdge = null;
      showDetailEmpty();
      if (STATE._graphNodeGroup) resetHighlight(STATE._graphLink, STATE._graphNodeGroup);
    }
  });
}

/* -------------------------------------------------------------------------
   GRAPH RENDER (D3 force-directed)
   ------------------------------------------------------------------------- */
function initGraph() {
  const svg = d3.select("#networkSvg");
  STATE.svg = svg;
  const g = svg.append("g").attr("class", "zoom-layer");
  STATE.zoomG = g;

  g.append("g").attr("class", "links-layer");
  g.append("g").attr("class", "nodes-layer");

  const zoom = d3.zoom()
    .scaleExtent([0.3, 4])
    .on("zoom", (event) => g.attr("transform", event.transform));
  STATE.zoomBehavior = zoom;
  svg.call(zoom);

  document.getElementById("zoomInBtn").addEventListener("click", () => svg.transition().duration(200).call(zoom.scaleBy, 1.3));
  document.getElementById("zoomOutBtn").addEventListener("click", () => svg.transition().duration(200).call(zoom.scaleBy, 0.75));
  document.getElementById("zoomResetBtn").addEventListener("click", () => svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity));
}

function renderGraph() {
  const edges = filteredEdges();
  const nodeSet = filteredNodeInitials(edges);
  const emptyState = document.getElementById("graphEmptyState");

  if (nodeSet.size === 0) {
    emptyState.hidden = false;
    STATE.zoomG.select(".links-layer").selectAll("*").remove();
    STATE.zoomG.select(".nodes-layer").selectAll("*").remove();
    if (STATE.simulation) STATE.simulation.stop();
    return;
  }
  emptyState.hidden = true;

  const { degree, weightedDegree } = degreeMaps(edges);
  const nodeArr = [...nodeSet].map(init => ({
    id: init,
    degree: degree.get(init) || 0,
    weightedDegree: weightedDegree.get(init) || 0,
  }));
  const nodeById = new Map(nodeArr.map(n => [n.id, n]));

  const linkArr = edges
    .filter(e => nodeById.has(facIdToInitials(e.source)) && nodeById.has(facIdToInitials(e.target)))
    .map(e => ({
      source: facIdToInitials(e.source),
      target: facIdToInitials(e.target),
      weight: e.weight,
      shared_items: e.shared_items,
      relation_type: e.relation_type,
    }));

  const svgNode = document.getElementById("networkSvg");
  const width = svgNode.clientWidth || 800;
  const height = svgNode.clientHeight || 560;

  const wMax = d3.max(linkArr, d => d.weight) || 1;
  const wdMax = d3.max(nodeArr, d => d.weightedDegree) || 1;

  const strokeScale = d3.scaleSqrt().domain([1, wMax]).range([1.2, 9]).clamp(true);
  const radiusScale = d3.scaleSqrt().domain([0, wdMax]).range([16, 42]).clamp(true);
  const colorScale = d3.scaleOrdinal(d3.schemeTableau10.concat(d3.schemeSet3));
  colorScale.domain(allFacultyInitials());

  if (STATE.simulation) STATE.simulation.stop();

  const simulation = d3.forceSimulation(nodeArr)
    .force("link", d3.forceLink(linkArr).id(d => d.id).distance(l => 70 + (1 - Math.min(l.weight / wMax, 1)) * 90).strength(0.5))
    .force("charge", d3.forceManyBody().strength(-320))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius(d => radiusScale(d.weightedDegree) + 8));
  STATE.simulation = simulation;

  const linksLayer = STATE.zoomG.select(".links-layer");
  const nodesLayer = STATE.zoomG.select(".nodes-layer");
  linksLayer.selectAll("*").remove();
  nodesLayer.selectAll("*").remove();

  const tooltip = d3.select("#graphTooltip");

  const link = linksLayer.selectAll("line")
    .data(linkArr)
    .join("line")
    .attr("class", "link-line")
    .attr("stroke-width", d => strokeScale(d.weight))
    .on("mouseenter", (event, d) => {
      const label = STATE.mode === "shared_account" ? "Shared accounts" : "Shared links";
      showTooltip(event, `<strong>${d.source} ↔ ${d.target}</strong><br>${label}: ${d.shared_items}`);
    })
    .on("mousemove", (event) => moveTooltip(event))
    .on("mouseleave", hideTooltip)
    .on("click", (event, d) => {
      event.stopPropagation();
      selectEdge(d.source, d.target);
    });

  const nodeGroup = nodesLayer.selectAll("g.node-g")
    .data(nodeArr, d => d.id)
    .join("g")
    .attr("class", "node-g")
    .call(d3.drag()
      .on("start", (event, d) => { if (!event.active) simulation.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
      .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
      .on("end", (event, d) => { if (!event.active) simulation.alphaTarget(0); d.fx = null; d.fy = null; }));

  nodeGroup.append("circle")
    .attr("class", "node-circle")
    .attr("r", d => radiusScale(d.weightedDegree))
    .attr("fill", d => colorScale(d.id))
    .on("mouseenter", (event, d) => {
      showTooltip(event, `<strong>${d.id}</strong><br>Degree: ${d.degree}<br>Weighted degree: ${d.weightedDegree}`);
      highlightNeighbors(d.id, link, nodeGroup, linkArr);
    })
    .on("mousemove", (event) => moveTooltip(event))
    .on("mouseleave", (event, d) => { hideTooltip(); if (!STATE.selectedNode) resetHighlight(link, nodeGroup); else highlightNeighbors(STATE.selectedNode, link, nodeGroup, linkArr); })
    .on("click", (event, d) => {
      event.stopPropagation();
      selectFacultyNode(d.id);
    });

  nodeGroup.append("text")
    .attr("class", "node-label")
    .attr("text-anchor", "middle")
    .attr("dy", d => radiusScale(d.weightedDegree) + 13)
    .text(d => d.id);

  simulation.on("tick", () => {
    link
      .attr("x1", d => d.source.x).attr("y1", d => d.source.y)
      .attr("x2", d => d.target.x).attr("y2", d => d.target.y);
    nodeGroup.attr("transform", d => `translate(${d.x},${d.y})`);
  });

  STATE._graphNodeGroup = nodeGroup;
  STATE._graphLink = link;
  STATE._graphNodeArr = nodeArr;
  STATE._graphLinkArr = linkArr;

  if (STATE.selectedNode && nodeById.has(STATE.selectedNode)) {
    highlightNeighbors(STATE.selectedNode, link, nodeGroup, linkArr);
  }
  highlightSearch();
}

function showTooltip(event, html) {
  const tt = document.getElementById("graphTooltip");
  tt.innerHTML = html;
  tt.hidden = false;
  moveTooltip(event);
}
function moveTooltip(event) {
  const wrap = document.querySelector(".graph-wrap").getBoundingClientRect();
  const tt = document.getElementById("graphTooltip");
  tt.style.left = (event.clientX - wrap.left + 14) + "px";
  tt.style.top = (event.clientY - wrap.top + 10) + "px";
}
function hideTooltip() { document.getElementById("graphTooltip").hidden = true; }

function highlightNeighbors(facId, link, nodeGroup, linkArr) {
  const neighbors = new Set([facId]);
  linkArr.forEach(l => {
    if (l.source.id === facId || l.source === facId) neighbors.add(l.target.id || l.target);
    if (l.target.id === facId || l.target === facId) neighbors.add(l.source.id || l.source);
  });
  nodeGroup.select("circle").classed("dimmed", d => !neighbors.has(d.id));
  link.classed("dimmed", d => (d.source.id || d.source) !== facId && (d.target.id || d.target) !== facId);
  link.classed("highlighted", d => (d.source.id || d.source) === facId || (d.target.id || d.target) === facId);
}
function resetHighlight(link, nodeGroup) {
  if (!nodeGroup) return;
  nodeGroup.select("circle").classed("dimmed", false);
  link.classed("dimmed", false).classed("highlighted", false);
}

function highlightSearch() {
  if (!STATE._graphNodeGroup) return;
  const term = STATE.searchTerm;
  if (!term) {
    if (!STATE.selectedNode) resetHighlight(STATE._graphLink, STATE._graphNodeGroup);
    STATE._graphNodeGroup.select("circle").attr("stroke", "#fff").attr("stroke-width", 2);
    return;
  }
  STATE._graphNodeGroup.select("circle")
    .attr("stroke", d => d.id.includes(term) ? "#0f2f5c" : "#fff")
    .attr("stroke-width", d => d.id.includes(term) ? 4 : 2);
  STATE._graphNodeGroup.select("circle").classed("dimmed", d => !d.id.includes(term));
}

/* -------------------------------------------------------------------------
   SELECTION / DETAIL PANEL
   ------------------------------------------------------------------------- */
function showDetailEmpty() {
  document.getElementById("detailEmpty").hidden = false;
  document.getElementById("detailFaculty").hidden = true;
  document.getElementById("detailEdge").hidden = true;
}

function selectFacultyNode(initials, opts = {}) {
  STATE.selectedNode = initials;
  STATE.selectedEdge = null;
  renderDetailFaculty(initials);
  if (STATE._graphNodeGroup) highlightNeighbors(initials, STATE._graphLink, STATE._graphNodeGroup, STATE._graphLinkArr);
  if (!opts.skipSync) {
    const sel = document.getElementById("globalFacultySelect");
    if (sel && sel.value !== initials) sel.value = initials;
    STATE.globalFaculty = initials;
    renderExecutiveSummary();
  }
}

function selectEdge(a, b) {
  STATE.selectedEdge = { a, b };
  STATE.selectedNode = null;
  renderDetailEdge(a, b);
  if (STATE._graphNodeGroup) resetHighlight(STATE._graphLink, STATE._graphNodeGroup);
}

function renderDetailFaculty(initials) {
  const fac = [...STATE.facultyById.values()].find(f => f.faculty_initials === initials);
  const facId = `${FAC_ID_PREFIX}${initials}`;
  const nodeMeta = STATE.facultyNodeMeta.get(facId) || {};
  const edges = filteredEdges().filter(e => facIdToInitials(e.source) === initials || facIdToInitials(e.target) === initials);
  const { degree, weightedDegree } = degreeMaps(filteredEdges());

  document.getElementById("detailEmpty").hidden = true;
  document.getElementById("detailEdge").hidden = true;
  document.getElementById("detailFaculty").hidden = false;

  document.getElementById("dfName").textContent = initials;
  document.getElementById("dfInitials").textContent = fac ? `ID: ${fac.faculty_id}` : "";
  document.getElementById("dfFullName").textContent = fac ? fac.faculty_name : "";
  document.getElementById("dfDegree").textContent = fmt(degree.get(initials) || 0);
  document.getElementById("dfWeightedDegree").textContent = fmt(weightedDegree.get(initials) || 0);
  document.getElementById("dfAccounts").textContent = fmt(nodeMeta.accounts);
  document.getElementById("dfLinks").textContent = fmt(nodeMeta.contents);
  document.getElementById("dfRecords").textContent = fmt(nodeMeta.mentions);
  document.getElementById("dfContents").textContent = fmt(nodeMeta.contents);

  // Mentions & sentiment dari monitoring_clean.xlsx, mengikuti periode aktif (filter kanan atas)
  const monRows = monitoringRows({ faculty: initials });
  const s = summarizeMonitoringRows(monRows);
  document.getElementById("dfMentionsTotal").textContent = fmt(s.totalMentions);
  const bar = document.getElementById("dfSentimentBar");
  const legend = document.getElementById("dfSentimentLegend");
  if (s.totalMentions === 0) {
    bar.innerHTML = "";
    legend.innerHTML = `<span>Tidak ada mentions pada periode ini.</span>`;
  } else {
    const posW = (s.pos / s.totalMentions) * 100;
    const netW = (s.net / s.totalMentions) * 100;
    const negW = (s.neg / s.totalMentions) * 100;
    bar.innerHTML = `<span class="seg-pos" style="width:${posW}%"></span><span class="seg-net" style="width:${netW}%"></span><span class="seg-neg" style="width:${negW}%"></span>`;
    legend.innerHTML = `
      <span class="leg-pos">Positif ${s.pos} (${posW.toFixed(0)}%)</span>
      <span class="leg-net">Netral ${s.net} (${netW.toFixed(0)}%)</span>
      <span class="leg-neg">Negatif ${s.neg} (${negW.toFixed(0)}%)</span>`;
  }

  const list = document.getElementById("dfConnectionList");
  if (edges.length === 0) {
    list.innerHTML = `<div class="connection-item">Tidak ada koneksi pada filter saat ini.</div>`;
  } else {
    const rows = edges
      .map(e => {
        const other = facIdToInitials(e.source) === initials ? facIdToInitials(e.target) : facIdToInitials(e.source);
        return { other, weight: e.weight };
      })
      .sort((a, b) => b.weight - a.weight);
    list.innerHTML = rows.map(r => `
      <div class="connection-item" data-fac="${r.other}">
        <span class="conn-name">${initials} ↔ ${r.other}</span>
        <span class="conn-weight">${r.weight}</span>
      </div>`).join("");
    list.querySelectorAll(".connection-item").forEach(el => {
      el.addEventListener("click", () => selectEdge(initials, el.dataset.fac));
    });
  }
}

function renderDetailEdge(a, b) {
  const edges = activeProjectionEdges();
  const edge = edges.find(e => {
    const ea = facIdToInitials(e.source), eb = facIdToInitials(e.target);
    return (ea === a && eb === b) || (ea === b && eb === a);
  });
  document.getElementById("detailEmpty").hidden = true;
  document.getElementById("detailFaculty").hidden = true;
  document.getElementById("detailEdge").hidden = false;

  document.getElementById("deTitle").textContent = `${a} ↔ ${b}`;
  const modeLabel = STATE.mode === "shared_account" ? "Shared Account Connection" : "Shared Link Connection";
  document.getElementById("deSubtitle").textContent = modeLabel;
  document.getElementById("deWeight").textContent = edge ? fmt(edge.weight) : "0";
  document.getElementById("deWeightLabel").textContent = STATE.mode === "shared_account" ? "Shared accounts" : "Shared links";
  document.getElementById("deType").textContent = edge ? edge.relation_type : "—";
  document.getElementById("deListTitle").textContent = STATE.mode === "shared_account" ? "Daftar Akun yang Sama" : "Daftar Link yang Sama";

  const itemsList = document.getElementById("deItemsList");
  const bip = activeBipartiteEdges();
  if (STATE.mode === "shared_account") {
    const setA = new Set(bip.filter(e => e.faculty_initials === a).map(e => e.account_id));
    const accountLabel = new Map(bip.filter(e => e.faculty_initials === a || e.faculty_initials === b).map(e => [e.account_id, e.account_norm]));
    const setB = new Set(bip.filter(e => e.faculty_initials === b).map(e => e.account_id));
    const shared = [...setA].filter(x => setB.has(x));
    itemsList.innerHTML = shared.length
      ? shared.map(accId => `<div class="shared-item-row">@${accountLabel.get(accId) || accId}</div>`).join("")
      : `<div class="shared-item-row">Tidak ada data akun rinci untuk pasangan ini.</div>`;
  } else {
    const setA = new Set(bip.filter(e => e.faculty_initials === a).map(e => e.link_norm));
    const setB = new Set(bip.filter(e => e.faculty_initials === b).map(e => e.link_norm));
    const shared = [...setA].filter(x => setB.has(x));
    itemsList.innerHTML = shared.length
      ? shared.map(url => `<div class="shared-item-row"><a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a></div>`).join("")
      : `<div class="shared-item-row">Tidak ada data link rinci untuk pasangan ini.</div>`;
  }
}

/* -------------------------------------------------------------------------
   NETWORK METRICS PANEL
   ------------------------------------------------------------------------- */
function renderMetrics() {
  const edges = filteredEdges();
  const nodeSet = filteredNodeInitials(edges);
  const n = nodeSet.size;
  const m = edges.length;
  const { degree, weightedDegree } = degreeMaps(edges);

  const density = n > 1 ? (2 * m) / (n * (n - 1)) : 0;
  const avgDegree = n > 0 ? [...degree.values()].reduce((a, b) => a + b, 0) / n : 0;
  const avgWDegree = n > 0 ? [...weightedDegree.values()].reduce((a, b) => a + b, 0) / n : 0;

  document.getElementById("mNodes").textContent = fmt(n);
  document.getElementById("mEdges").textContent = fmt(m);
  document.getElementById("mDensity").textContent = density.toFixed(3);
  document.getElementById("mAvgDegree").textContent = avgDegree.toFixed(2);
  document.getElementById("mAvgWDegree").textContent = avgWDegree.toFixed(2);

  const nodeList = [...nodeSet];
  const centralities = computeCentralities(nodeList, edges);
  const rows = nodeList
    .map(f => ({
      f,
      degree: degree.get(f) || 0,
      wd: weightedDegree.get(f) || 0,
      c: centralities.get(f) || { degreeCentrality: 0, betweenness: 0, closeness: 0 },
    }))
    .sort((a, b) => b.wd - a.wd);

  document.getElementById("centralityTableBody").innerHTML = rows.map(r => `
    <tr>
      <td>${r.f}</td>
      <td class="num">${r.degree}</td>
      <td class="num">${r.wd}</td>
      <td class="num">${r.c.degreeCentrality.toFixed(3)}</td>
      <td class="num">${r.c.betweenness.toFixed(3)}</td>
      <td class="num">${r.c.closeness.toFixed(3)}</td>
    </tr>`).join("") || `<tr><td colspan="6">Tidak ada data pada filter ini.</td></tr>`;
}

/* -------------------------------------------------------------------------
   TABLE VIEW (sort, search, paginate)
   ------------------------------------------------------------------------- */
const TABLE_STATE = { sortKey: "weight", sortDir: "desc", page: 1, pageSize: 10, search: "" };

function edgeTableRows() {
  return filteredEdges().map(e => ({
    a: facIdToInitials(e.source),
    b: facIdToInitials(e.target),
    shared_items: e.shared_items,
    weight: e.weight,
  }));
}

function renderTable() {
  let rows = edgeTableRows();
  if (TABLE_STATE.search) {
    const s = TABLE_STATE.search.toLowerCase();
    rows = rows.filter(r => r.a.toLowerCase().includes(s) || r.b.toLowerCase().includes(s));
  }
  rows.sort((x, y) => {
    const dir = TABLE_STATE.sortDir === "asc" ? 1 : -1;
    const kv = TABLE_STATE.sortKey;
    if (typeof x[kv] === "number") return (x[kv] - y[kv]) * dir;
    return String(x[kv]).localeCompare(String(y[kv])) * dir;
  });

  const totalPages = Math.max(1, Math.ceil(rows.length / TABLE_STATE.pageSize));
  TABLE_STATE.page = Math.min(TABLE_STATE.page, totalPages);
  const start = (TABLE_STATE.page - 1) * TABLE_STATE.pageSize;
  const pageRows = rows.slice(start, start + TABLE_STATE.pageSize);

  document.getElementById("edgeTableBody").innerHTML = pageRows.length
    ? pageRows.map(r => `
      <tr>
        <td>${r.a}</td>
        <td>${r.b}</td>
        <td class="num">${fmt(r.shared_items)}</td>
        <td class="num">${fmt(r.weight)}</td>
      </tr>`).join("")
    : `<tr><td colspan="4">Tidak ada hubungan pada filter ini.</td></tr>`;

  renderPagination(totalPages, rows.length);
}

function renderPagination(totalPages, totalRows) {
  const el = document.getElementById("tablePagination");
  if (totalRows === 0) { el.innerHTML = ""; return; }
  let html = `<span style="align-self:center;font-size:12px;color:var(--gray-500);margin-right:8px;">${totalRows} baris</span>`;
  html += `<button ${TABLE_STATE.page === 1 ? "disabled" : ""} data-page="${TABLE_STATE.page - 1}">‹</button>`;
  for (let p = 1; p <= totalPages; p++) {
    if (totalPages > 7 && Math.abs(p - TABLE_STATE.page) > 2 && p !== 1 && p !== totalPages) {
      if (p === 2 || p === totalPages - 1) html += `<span style="align-self:center;">…</span>`;
      continue;
    }
    html += `<button class="${p === TABLE_STATE.page ? "active" : ""}" data-page="${p}">${p}</button>`;
  }
  html += `<button ${TABLE_STATE.page === totalPages ? "disabled" : ""} data-page="${TABLE_STATE.page + 1}">›</button>`;
  el.innerHTML = html;
  el.querySelectorAll("button[data-page]").forEach(btn => {
    btn.addEventListener("click", () => { TABLE_STATE.page = Number(btn.dataset.page); renderTable(); });
  });
}

function setupTableControls() {
  document.querySelectorAll("#edgeTable thead th[data-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (TABLE_STATE.sortKey === key) {
        TABLE_STATE.sortDir = TABLE_STATE.sortDir === "asc" ? "desc" : "asc";
      } else {
        TABLE_STATE.sortKey = key;
        TABLE_STATE.sortDir = "desc";
      }
      TABLE_STATE.page = 1;
      renderTable();
    });
  });
  document.getElementById("tableSearch").addEventListener("input", (e) => {
    TABLE_STATE.search = e.target.value;
    TABLE_STATE.page = 1;
    renderTable();
  });
}

/* -------------------------------------------------------------------------
   GLOBAL RENDER
   ------------------------------------------------------------------------- */
function renderAll() {
  document.getElementById("weightSliderValue").textContent = STATE.minWeight;
  renderGraph();
  renderMetrics();
  renderTable();
  if (STATE.selectedNode) renderDetailFaculty(STATE.selectedNode);
  if (STATE.selectedEdge) renderDetailEdge(STATE.selectedEdge.a, STATE.selectedEdge.b);
}

/* -------------------------------------------------------------------------
   INIT
   ------------------------------------------------------------------------- */
async function init() {
  try {
    await loadAllData();
  } catch (err) {
    document.body.innerHTML = `<div style="padding:40px;font-family:sans-serif;color:#991b1b;">
      <h2>Gagal memuat data</h2>
      <p>${err.message}</p>
      <p>Pastikan dashboard dijalankan melalui local server (mis. <code>python -m http.server 8000</code>), bukan dibuka langsung sebagai file://.</p>
    </div>`;
    return;
  }

  renderKPIs();
  renderValidation();
  setupFilterControls();
  setupTopbarControls();
  setupTableControls();
  initGraph();
  renderExecutiveSummary();
  renderAll();

  document.getElementById("networkSvg").addEventListener("click", () => {
    // click on empty svg background clears selection
  });

  window.addEventListener("resize", () => {
    clearTimeout(window.__resizeTimer);
    window.__resizeTimer = setTimeout(renderGraph, 200);
  });
}

document.addEventListener("DOMContentLoaded", init);
