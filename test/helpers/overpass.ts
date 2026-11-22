// Jawaban Overpass kecil untuk tes: fitur dan rute di Bogor Tengah, ditambah fitur dan rute di Jakarta yang harus dibuang.
import type { OverpassElement } from "../../src/knowledge/osm.js";

// Titik di Bogor Tengah dan di Jakarta Pusat.
const bogor = { lat: -6.595, lon: 106.795 };
const jakarta = { lat: -6.2, lon: 106.82 };

export const elements: OverpassElement[] = [
  { type: "node", id: 1, ...bogor, tags: { highway: "bus_stop", name: "Halte Kebun Raya", phone: "+62 251 000", website: "https://contoh.id" } },
  { type: "node", id: 2, ...jakarta, tags: { highway: "bus_stop", name: "Halte Monas" } },
  { type: "node", id: 3, lat: -6.596, lon: 106.796, tags: { amenity: "toilets", wheelchair: "yes", "toilets:wheelchair": "yes", operator: "Pemkot" } },
  { type: "node", id: 4, lat: -6.5955, lon: 106.7955, tags: { highway: "crossing", kerb: "raised", tactile_paving: "no" } },
  {
    type: "way",
    id: 10,
    geometry: [
      { lat: -6.595, lon: 106.796 },
      { lat: -6.5952, lon: 106.7962 },
    ],
    tags: { highway: "steps", step_count: "12", handrail: "yes", "ramp:wheelchair": "no" },
  },
  { type: "relation", id: 20, center: { lat: -6.597, lon: 106.799 }, tags: { type: "multipolygon", building: "yes", wheelchair: "limited", name: "Gedung Contoh" } },
  {
    type: "relation",
    id: 100,
    tags: { type: "route", route: "bus", ref: "02", name: "Sukasari–Bubulak", network: "Angkutan Kota Bogor", from: "Sukasari", to: "Bubulak" },
    members: [
      { type: "node", ref: 1, role: "stop", ...bogor },
      { type: "node", ref: 1, role: "platform", ...bogor },
      { type: "node", ref: 2, role: "stop", ...jakarta },
      {
        type: "way",
        ref: 50,
        role: "",
        geometry: [
          { lat: -6.594, lon: 106.794 },
          { lat: -6.596, lon: 106.797 },
        ],
      },
      {
        type: "way",
        ref: 51,
        role: "",
        geometry: [
          { lat: -6.2, lon: 106.82 },
          { lat: -6.201, lon: 106.821 },
        ],
      },
    ],
  },
  {
    type: "relation",
    id: 101,
    tags: { type: "route", route: "bus", ref: "T1", name: "Monas–Kota", operator: "Transjakarta", network: "Transjakarta" },
    members: [
      { type: "node", ref: 2, role: "stop", ...jakarta },
      {
        type: "way",
        ref: 51,
        role: "",
        geometry: [
          { lat: -6.2, lon: 106.82 },
          { lat: -6.201, lon: 106.821 },
        ],
      },
    ],
  },
  { type: "way", id: 50, tags: { highway: "primary", name: "Jalan Pajajaran" } },
  { type: "way", id: 51, tags: { highway: "primary", name: "Jalan Medan Merdeka" } },
];
