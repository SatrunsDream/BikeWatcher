import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// Set your Mapbox access token here
mapboxgl.accessToken = 'pk.eyJ1Ijoic2F0dXJuZHJlYW0iLCJhIjoiY21hdDM2NWltMGh0YjJ3b2s4cGUyb3AyeCJ9.twOOG3HIqF-Q7h--vrsHNw';

// Initialize the map
const map = new mapboxgl.Map({
  container: 'map',
  style: 'mapbox://styles/mapbox/streets-v12',
  center: [-71.09415, 42.36027],
  zoom: 12,
  minZoom: 5,
  maxZoom: 18,
});

// Select the SVG overlay
const svg = d3.select('#map').select('svg');

// Helper: project station coordinates to map pixels
function getCoords(station) {
  const point = new mapboxgl.LngLat(+station.lon, +station.lat);
  const { x, y } = map.project(point);
  return { cx: x, cy: y };
}

// Helper: minutes since midnight
function minutesSinceMidnight(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Helper: format time for slider
function formatTime(minutes) {
  if (minutes < 0) return "(any time)";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

// Efficient filtering by minute
function filterByMinute(tripsByMinute, minute) {
  if (minute === -1) return tripsByMinute.flat();
  let result = [];
  for (let i = -60; i <= 60; ++i) {
    let idx = (minute + i + 1440) % 1440;
    result = result.concat(tripsByMinute[idx]);
  }
  return result;
}

// Compute arrivals, departures, totalTraffic for each station
function computeStationTraffic(stations, timeFilter = -1) {
  const departures = d3.rollup(
    filterByMinute(departuresByMinute, timeFilter),
    v => v.length,
    d => d.start_station_id
  );
  const arrivals = d3.rollup(
    filterByMinute(arrivalsByMinute, timeFilter),
    v => v.length,
    d => d.end_station_id
  );
  return stations.map(station => {
    let id = station.short_name;
    station.departures = departures.get(id) ?? 0;
    station.arrivals = arrivals.get(id) ?? 0;
    station.totalTraffic = station.departures + station.arrivals;
    return station;
  });
}

// D3 scales
const radiusScale = d3.scaleSqrt().range([0, 7]); // much smaller dots
const stationFlow = d3.scaleQuantize().domain([0, 1]).range([0, 0.5, 1]);

// Data buckets for performance
let stations = [];
let departuresByMinute = Array.from({ length: 1440 }, () => []);
let arrivalsByMinute = Array.from({ length: 1440 }, () => []);
let timeFilter = -1;

// Load data and render
map.on('load', async () => {
  // Add Boston and Cambridge bike lanes
  map.addSource('boston_route', {
    type: 'geojson',
    data: 'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson',
  });
  map.addLayer({
    id: 'bike-lanes',
    type: 'line',
    source: 'boston_route',
    paint: {
      'line-color': 'green',
      'line-width': 3,
      'line-opacity': 0.4,
    },
  });
  map.addSource('cambridge_route', {
    type: 'geojson',
    data: 'https://data.cambridgema.gov/resource/ueqv-6f6n.geojson',
  });
  map.addLayer({
    id: 'cambridge-bike-lanes',
    type: 'line',
    source: 'cambridge_route',
    paint: {
      'line-color': '#32D400',
      'line-width': 5,
      'line-opacity': 0.6,
    },
  });

  // Load stations and trips
  const stationData = await d3.json('bluebikes-stations.json');
  stations = stationData.data.stations.filter(d => d.lat && d.lon && d.short_name);

  const trips = await d3.csv(
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv',
    trip => {
      trip.started_at = new Date(trip.started_at);
      trip.ended_at = new Date(trip.ended_at);
      return trip;
    }
  );

  // Pre-bucket trips by minute
  departuresByMinute = Array.from({ length: 1440 }, () => []);
  arrivalsByMinute = Array.from({ length: 1440 }, () => []);
  for (const trip of trips) {
    const depMin = minutesSinceMidnight(trip.started_at);
    const arrMin = minutesSinceMidnight(trip.ended_at);
    if (depMin >= 0 && depMin < 1440) departuresByMinute[depMin].push(trip);
    if (arrMin >= 0 && arrMin < 1440) arrivalsByMinute[arrMin].push(trip);
  }

  // Initial scatterplot
  updateScatterPlot(timeFilter);

  // Keep circles in sync with map movement
  map.on('move', () => updateScatterPlot(timeFilter));
  map.on('zoom', () => updateScatterPlot(timeFilter));
  map.on('resize', () => updateScatterPlot(timeFilter));
  map.on('moveend', () => updateScatterPlot(timeFilter));
});

// --- Legend interactivity ---
const legendDivs = Array.from(document.querySelectorAll('.legend > div'));
let legendSelected = [false, false, false];

legendDivs.forEach((div, idx) => {
  div.addEventListener('click', e => {
    e.stopPropagation();
    legendSelected[idx] = !legendSelected[idx];
    div.classList.toggle('selected');
    updateScatterPlot(timeFilter);
  });
});

document.body.addEventListener('click', e => {
  if (!e.target.closest('.legend > div')) {
    legendSelected = [false, false, false];
    legendDivs.forEach(d => d.classList.remove('selected'));
    updateScatterPlot(timeFilter);
  }
}, true);

// Update scatterplot for current time filter
function updateScatterPlot(timeFilter) {
  const filteredStations = computeStationTraffic(stations, timeFilter);
  // Dynamic radius range for filtering
  if (timeFilter === -1) {
    radiusScale.range([0, 7]);
  } else {
    radiusScale.range([2, 12]);
  }
  radiusScale.domain([0, d3.max(filteredStations, d => d.totalTraffic) || 1]);

  // If any legend is selected, filter by selected flows
  let displayStations = filteredStations;
  if (legendSelected.some(Boolean)) {
    displayStations = filteredStations.filter(d => {
      if (!d.totalTraffic) return false;
      const ratio = stationFlow(d.departures / d.totalTraffic);
      // idx 0: departures (1), idx 1: balanced (0.5), idx 2: arrivals (0)
      if (ratio === 1 && legendSelected[0]) return true;
      if (ratio === 0.5 && legendSelected[1]) return true;
      if (ratio === 0 && legendSelected[2]) return true;
      return false;
    });
  }

  const circles = svg
    .selectAll('circle')
    .data(displayStations, d => d.short_name);

  circles.join(
    enter => enter.append('circle')
      .attr('r', 0)
      .attr('cx', d => getCoords(d).cx)
      .attr('cy', d => getCoords(d).cy)
      .attr('style', d => `--departure-ratio:${d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5}`)
      .each(function (d) {
        d3.select(this)
          .append('title')
          .text(`${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`);
      }),
    update => update
      .attr('cx', d => getCoords(d).cx)
      .attr('cy', d => getCoords(d).cy)
      .attr('r', d => radiusScale(d.totalTraffic))
      .attr('style', d => `--departure-ratio:${d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5}`)
      .select('title')
      .text(d => `${d.totalTraffic} trips (${d.departures} departures, ${d.arrivals} arrivals)`),
    exit => exit.remove()
  )
  .attr('r', d => radiusScale(d.totalTraffic))
  .attr('cx', d => getCoords(d).cx)
  .attr('cy', d => getCoords(d).cy)
  .attr('style', d => `--departure-ratio:${d.totalTraffic ? stationFlow(d.departures / d.totalTraffic) : 0.5}`);

  svg.selectAll('circle')
    .on('mouseenter', function () { d3.select(this).attr('stroke-width', 4); })
    .on('mouseleave', function () { d3.select(this).attr('stroke-width', 2); });
}

// --- Time slider ---
const slider = document.getElementById('time-slider');
const selectedTime = document.getElementById('selected-time');
const anyTime = document.getElementById('any-time');

function updateTimeDisplay() {
  const val = +slider.value;
  if (val < 0) {
    selectedTime.textContent = '';
    anyTime.style.display = '';
  } else {
    selectedTime.textContent = formatTime(val);
    anyTime.style.display = 'none';
  }
  timeFilter = val;
  updateScatterPlot(val);
}

slider.addEventListener('input', updateTimeDisplay);
updateTimeDisplay();
