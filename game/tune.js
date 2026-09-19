// Every number and every colour in the game, in one object per system.
//
// The bake writes CLASS INDICES and the manifest writes the class NAMES at those
// indices; this file maps names to a look. That seam is the point: retuning the
// palette must never mean re-baking a city, and a class the bake learns tomorrow
// falls back to a default here instead of crashing.
//
// Portland is a grey-green city -- basalt, moss, fir, painted clapboard, brick.
// The palette is built from that rather than from the usual video-game city of
// concrete and glass, because what makes a place recognisable at a distance is
// its COLOUR long before it is its geometry.

export const SKY = {
  top:      0x9dc4e8,
  horizon:  0xd9dfd4,
  sun:      0xfff0d6,
  sunDir:   [0.42, 0.72, 0.55],     // normalised in main.js; afternoon, over the hills
  // Fog is the horizon, not a filter. At 220..1500 downtown read as white
  // ghosts from the far bank -- a kilometre is nothing in a river city, and the
  // whole point of the skyline is that you can see it. It starts past the
  // streamed chunks now and ends past the skyline boxes.
  fogNear:  420,
  fogFar:   3200,
  fogColor: 0xbfd0d8,
  ambientSky:    0xa8c8e4,          // hemisphere light: cool from above,
  ambientGround: 0xa08e70,          // warm bounce from below. This pair is the
  ambientI: 1.22,                   // whole stylised shadow/light split, for free.
  sunI: 1.12,
  // A FILL, from the opposite quarter and much weaker. A hemisphere light gives
  // a vertical wall the same answer whichever way it faces, so on its own the
  // only thing separating a sunlit facade from a shaded one is the sun -- and
  // that made every north and west wall in the city read as a hole. Three-point
  // lighting's second lamp, for the cost of one more Lambert term.
  fillDir: [-0.55, 0.38, -0.74],
  fill: 0x9fb6cc,
  fillI: 0.62,
  // ACES, at an exposure under one. Without tone mapping every lit surface in a
  // city of pale walls clips to flat white and the palette may as well not
  // exist -- the first build shipped that and read as grey cardboard. The sum
  // of the two light intensities is deliberately near 1.7 rather than over 2:
  // Lambert has no ceiling of its own and the tone curve should be shaping a
  // picture, not rescuing one.
  exposure: 1.06,
};

// The character. He is a PBR skinned mesh in a city of flat-shaded vertex
// colours, so he answers the light differently from everything around him --
// and this scene has one sun, one hemisphere and no bounce at all, which leaves
// his shaded side with nowhere to get light from. Feeding his own base map back
// as a low emission is Shredworld's answer to exactly that. At 0.26 he read as
// a silhouette; this is the dial.
export const CHAR = { emissive: 0.55, height: 1.78 };

export const CAM = {
  dist: 7.2, minDist: 2.6, hardMin: 0.85, maxDist: 16,
  // How much boom counts as "a shot", the extra pitch tried to find it, and the
  // ceiling on how far the lens will climb looking.
  room: 4.2, lifts: [0, 0.34, 0.72, 1.05], pitchMax: 1.32,
  height: 2.5,          // metres above his feet that the lens looks at
  pitch: 0.24,          // radians below horizontal, the default shot
  pitchHi: 0.62,        // the EYE key's second shot, for looking at the skyline
  orbitRate: 2.5,       // radians per second at full right-stick deflection
  followHL: 0.22,       // half-life of the boom easing in behind him
  lookHL: 0.10,
  probe: 0.6,           // metres per step when the boom is looking for a wall
  fov: 62,
};

export const MOVE = {
  walk: 1.9, run: 6.4, sprint: 9.2,
  accel: 26, decel: 30, turnAccel: 60,
  faceHL: 0.09,          // how fast his body comes round to the thumb
  g: 22,
  jump: 6.4,
  airControl: 0.35,
  radius: 0.42,          // his collision cylinder
  eye: 1.72,
  step: 0.45,            // anything this high is walked onto, not collided with
  coyote: 0.12,
};

// Buildings. `wall` and `roof`, plus a `vary` that hue-jitters per building so a
// street of identical class is not a street of identical colour -- Portland's
// residential stock is painted, and the variety IS the look.
const B = (wall, roof, vary = 0.05) => ({ wall, roof, vary });
export const BUILDING = {
  house:        B(0xd8cfbc, 0x8a7a68, 0.13),
  detached:     B(0xd2c8b4, 0x877867, 0.14),
  garage:       B(0xada396, 0x847b72, 0.08),
  outbuilding:  B(0xa89e90, 0x817a74, 0.08),
  apartments:   B(0xc0a893, 0x7b7268, 0.09),
  residential:  B(0xc8bca8, 0x807668, 0.10),
  commercial:   B(0xcfc6b4, 0x777066, 0.06),
  retail:       B(0xd3c2ab, 0x7a7263, 0.07),
  office:       B(0x9fb0bb, 0x757f88, 0.05),
  industrial:   B(0xa8aaa4, 0x878a8a, 0.05),
  warehouse:    B(0xb0aea2, 0x8a8a82, 0.05),
  civic:        B(0xdad3c2, 0x847d70, 0.04),
  education:    B(0xd5c7ae, 0x967460, 0.05),
  religious:    B(0xdcd4c3, 0x977c66, 0.05),
  medical:      B(0xd9d6cc, 0x7f8688, 0.04),
  hotel:        B(0xc4b6a2, 0x787066, 0.05),
  parking:      B(0xa9a69e, 0xa3a099, 0.03),
  transit:      B(0xb6b3a9, 0x7d7a73, 0.04),
  tower:        B(0x93a6b4, 0x6f7981, 0.04),
  other:        B(0xc6bdac, 0x847d71, 0.07),
};
export const BUILDING_DEFAULT = BUILDING.other;

// A building is darker at its feet. Real ambient occlusion on a city this size
// is not affordable and is not the point: one vertical gradient baked into the
// vertex colours grounds every box for nothing, and reads from a hundred metres.
// Measured on screen rather than guessed: at 0.42 over six metres, a dark-walled
// tower spends its first two storeys at 58% of its own colour, which after the
// tone curve is near black -- and a downtown street of them reads as a canyon of
// soot. A quarter, over three metres, still grounds a box and leaves the palette
// alone above head height.
export const WALL_AO = { depth: 0.26, over: 3.6 };

export const ROAD = {
  motorway:     { c: 0x585754, over: 0.06 },
  trunk:        { c: 0x5b5a56, over: 0.06 },
  primary:      { c: 0x5e5c58, over: 0.05 },
  secondary:    { c: 0x605e59, over: 0.05 },
  tertiary:     { c: 0x63615c, over: 0.05 },
  residential:  { c: 0x6a675f, over: 0.04 },
  unclassified: { c: 0x6c6961, over: 0.04 },
  living_street:{ c: 0x6f6c63, over: 0.04 },
  service:      { c: 0x6f6c64, over: 0.03 },
  driveway:     { c: 0x77736a, over: 0.03 },
  parking_aisle:{ c: 0x73706a, over: 0.03 },
  alley:        { c: 0x6d6a63, over: 0.03 },
  pedestrian:   { c: 0x9d9384, over: 0.05 },
  footway:      { c: 0x9c9384, over: 0.06 },
  sidewalk:     { c: 0xa69c8c, over: 0.07 },
  crosswalk:    { c: 0xcdc7bb, over: 0.09 },
  steps:        { c: 0x8e8578, over: 0.09 },
  path:         { c: 0x968a76, over: 0.05 },
  cycleway:     { c: 0x7c7466, over: 0.06 },
  track:        { c: 0x8b8171, over: 0.04 },
  rail:         { c: 0x4e4a46, over: 0.05 },
  unknown:      { c: 0x6d6a62, over: 0.04 },
};
export const ROAD_DEFAULT = ROAD.unknown;
// A kerb is what makes a street a street rather than a stripe of grey. Carriageways
// get one; pavements, paths and rails do not.
export const KERB = { h: 0.13, w: 0.30, c: 0xb3aa9a,
  on: new Set(['motorway','trunk','primary','secondary','tertiary','residential',
               'unclassified','living_street','service','alley','parking_aisle']) };

export const AREA = {
  water:        { c: 0x3f6c7d, y: 0.00 },
  river:        { c: 0x3a6575, y: 0.00 },
  pond:         { c: 0x44758a, y: 0.00 },
  park:         { c: 0x5f8a36, y: 0.02 },
  grass:        { c: 0x6b9640, y: 0.02 },
  forest:       { c: 0x3a5f2c, y: 0.02 },
  scrub:        { c: 0x6d7a42, y: 0.02 },
  garden:       { c: 0x679439, y: 0.02 },
  pitch:        { c: 0x548a38, y: 0.03 },
  playground:   { c: 0xb08c63, y: 0.03 },
  sand:         { c: 0xd2c49b, y: 0.02 },
  plaza:        { c: 0xb3a994, y: 0.04 },
  parking:      { c: 0x87837b, y: 0.03 },
  school:       { c: 0xb2a289, y: 0.02 },
  religious:    { c: 0xa9a08c, y: 0.02 },
  cemetery:     { c: 0x6c8447, y: 0.02 },
  brownfield:   { c: 0x968a72, y: 0.02 },
  construction: { c: 0xa8977a, y: 0.02 },
  residential_lu:{ c: 0x9f9a86, y: 0.01 },
  retail_lu:    { c: 0xa1957f, y: 0.01 },
  commercial_lu:{ c: 0x9d9686, y: 0.01 },
  industrial_lu:{ c: 0x91908a, y: 0.01 },
  wetland:      { c: 0x54794a, y: 0.02 },
  railway:      { c: 0x7c766c, y: 0.02 },
  track:        { c: 0x8f8365, y: 0.02 },
};
export const AREA_DEFAULT = { c: 0x94906f, y: 0.02 };

// LAND USE IS NOT GROUND COVER, and drawing it as though it were is what made
// downtown one flat pale plain. `commercial`, `retail`, `residential` and
// `industrial` are ADMINISTRATIVE polygons: they cover a whole city block,
// roads and pavements and all, so painting them puts a single wash under
// everything and the terrain, the parks and the asphalt all stop reading. They
// stay in the BAKE -- they are real data and the map draws them -- and the game
// simply does not paint them. Delete a name from this set to get it back.
export const HIDE_AREA = new Set([
  'residential_lu', 'retail_lu', 'commercial_lu', 'industrial_lu',
  'brownfield', 'construction', 'railway',
]);

// Parked cars. Portland's own fleet, near enough: a lot of white, silver and
// grey, some dark blue and red, the occasional Subaru green.
export const CAR_COLORS = [
  0xd9dade, 0xb6bbc0, 0x8c9299, 0x54585e, 0x2d3138, 0x7d1f22, 0x1f3a5c,
  0x33503d, 0xb8a06a, 0x9d9fa4, 0xe4e2dc, 0x3c4c5e,
];

// The ground under everything. Terrain takes its colour from STEEPNESS, not from
// height: a flat bench and the bluff above it are the same soil, and shading by
// altitude paints a contour map onto a city.
// THE DEFAULT GROUND IS NOT GRASS. Outside the parks, the ground between
// buildings in a city is yards, gravel, back lanes and dirt -- painting it
// lawn-green makes every block look like a golf course, and painting it
// concrete makes the parks stop reading. A muted khaki sits between the two and
// lets the park and grass polygons carry the actual green.
export const TERRAIN = {
  flat: 0x84904f, steep: 0x736648, rock: 0x635d53,
  steepAt: 0.30, rockAt: 0.62,
};

export const WATER = { c: 0x3a6575, opacity: 0.88, shimmer: 0.04 };

export const PROP = {
  tree:          { h: 9.0,  c: 0x4e7a3c, trunk: 0x5c4936, kind: 'broadleaf' },
  tree_conifer:  { h: 19.0, c: 0x2f5438, trunk: 0x53412f, kind: 'conifer' },
  street_lamp:   { h: 7.2,  c: 0x4a4e52, kind: 'lamp' },
  traffic_signal:{ h: 4.6,  c: 0x3d4247, kind: 'signal' },
  stop_sign:     { h: 2.6,  c: 0xb03a30, kind: 'sign' },
  bench:         { h: 0.85, c: 0x7a5d3f, kind: 'bench' },
  hydrant:       { h: 0.82, c: 0xc0592f, kind: 'post' },
  bin:           { h: 1.0,  c: 0x4d5a4a, kind: 'box' },
  bollard:       { h: 0.95, c: 0x5b5f63, kind: 'post' },
  bus_stop:      { h: 2.9,  c: 0x47525c, kind: 'sign' },
  post_box:      { h: 1.3,  c: 0x3f5a72, kind: 'box' },
  drinking_fountain:{ h: 1.1, c: 0x4a5f52, kind: 'post' },
  power_pole:    { h: 10.5, c: 0x6a5741, kind: 'pole' },
  artwork:       { h: 3.2,  c: 0x8d7a5c, kind: 'box' },
  bike_rack:     { h: 0.9,  c: 0x6d7378, kind: 'rack' },
  planter:       { h: 0.8,  c: 0x7d7361, kind: 'box' },
  billboard:     { h: 6.0,  c: 0x9a9184, kind: 'sign' },
  parking_meter: { h: 1.25, c: 0x5c6166, kind: 'post' },
  newspaper_box: { h: 1.15, c: 0x566a74, kind: 'box' },
  picnic_table:  { h: 0.78, c: 0x81644a, kind: 'bench' },
  flagpole:      { h: 9.0,  c: 0xa6a29a, kind: 'pole' },
  fountain:      { h: 1.4,  c: 0x7e8a86, kind: 'box' },
  car:           { h: 1.48, c: 0xb6bbc0, kind: 'car' },
};
export const PROP_DEFAULT = { h: 1.2, c: 0x8a8578, kind: 'box' };
// Tree crowns pick one of these, indexed by the bake's `tint` byte, so one row of
// street trees is a row of trees rather than a row of one tree.
export const LEAF_TINTS = [0x5c8a40, 0x6e9b45, 0x47733a, 0x7fa64e,
                           0x53803e, 0x86a552];

// AGAINST that board rather than a fixed white -- a cream awning with white
// lettering is a blank awning, which is what the first pass shipped.
export const SHOP = {
  food:     { c: 0x9c3b2e, ink: '#fff3e2' },
  cafe:     { c: 0x6b4a33, ink: '#f7e9d4' },
  bar:      { c: 0x3c4a63, ink: '#ffe6a8' },
  shop:     { c: 0x3f6d63, ink: '#f4f7ee' },
  grocery:  { c: 0x5c7a35, ink: '#f7fbe9' },
  service:  { c: 0x5d5a52, ink: '#f2efe6' },
  salon:    { c: 0x8a4a6b, ink: '#ffeef6' },
  bank:     { c: 0x2f4f6e, ink: '#eaf2fb' },
  pharmacy: { c: 0x2f6b53, ink: '#e9fbf2' },
  culture:  { c: 0x6a4a8a, ink: '#f4ecff' },
  hotel:    { c: 0x7a5c2c, ink: '#fff4dd' },
  civic:    { c: 0x54606b, ink: '#eef3f7' },
  landmark: { c: 0x8a7440, ink: '#fff8e4' },
  fuel:     { c: 0x9a5a22, ink: '#fff0dd' },
  other:    { c: 0x69655c, ink: '#f3f1ea' },
};
export const SHOP_DEFAULT = SHOP.other;

export const SIGN = {
  boardH: 0.72,        // the sign band above the shopfront
  awning: 1.25,        // how far it reaches over the pavement
  awningDrop: 0.42,    // and how far it falls doing it
  valance: 0.26,       // the flap on the front edge
  // The readable half. 48 names at 256x128 on one 1024 canvas is a size you can
  // read from across the street; more slots means smaller type and a sign you
  // cannot read is a sign that may as well be blank.
  atlas: 1024, cols: 4, rows: 12,
  range: 85,           // metres within which a shop name is drawn at all
  every: 0.45,         // seconds between re-checks of the nearest set
  // A CELL IS KEYED ON THE TEXT, NOT ON THE SIGN. There are 435 distinct street
  // names in the whole city and a junction has the same one on both its
  // corners, so "SE HAWTHORNE BLVD" is drawn into the atlas ONCE and every
  // blade that says it is a quad into that one cell. Which is why there are
  // far more quads than there are slots.
  quads: 220,
};

// Street name blades: a post on a corner with a green rectangle on it saying
// what the street is. This is the cheapest legibility in the whole city --
// 2,275 junctions, no model authored for any of them, and the names are the
// one thing a generator cannot invent.
export const STREETSIGN = {
  // OVERSIZED ON PURPOSE, about half again life size. A real Portland blade is
  // 23 cm deep with 10 cm lettering, and measured at a natural walking
  // distance that comes out at the very edge of legible -- which fails the one
  // thing this exists for, which is being able to read "BURNSIDE" from where
  // you are standing rather than from the corner itself. Accurate and useless
  // is worse than large and readable; the money brick in Shredworld is the
  // same call for the same reason.
  postH: 3.05, postR: 0.058, post: 0x4b5450,
  bladeH: 0.40, bladeT: 0.04, drop: 0.46,    // the second blade sits under the first
  // MUTCD green with white lettering, which is what a Portland blade is. The
  // border is what makes it read as a sign at distance rather than as a green
  // smear: a plain rectangle of one colour is a shape, a rectangle with a line
  // inside it is a sign.
  face: 0x17603c, edge: 0xe8efe8, ink: '#f4f8f4', border: 0.030,
  // MEASURED OFF A REAL BLADE, not eyeballed: a Portland street sign is about
  // 75 cm of green for "NW 4TH AVE" and 1.1 m for "SE HAWTHORNE BLVD", which
  // is a condensed capital about 6 cm wide at a 10 cm cap height.
  charW: 0.095, pad: 0.25, minW: 0.92, maxW: 2.50,
  // Further than a shop's, because a street sign is the thing you go LOOKING
  // for -- the answer to "which way is Burnside" has to arrive before you have
  // walked to the corner to ask.
  range: 120,
  bias: 0.55,          // how much nearer than its metres a blade ranks
};

// How far the world is live. These are the frame budget: at 500 m a chunk,
// `keep` 1900 kept SIXTY-THREE chunks alive and drew 640k triangles for a view
// that fog closes at 1.3 km. The horizon is far.bin's job, and it is one draw
// call.
// The crowd. Everything here is a look decision and a frame budget, and the
// two are the same decision: `count` times sixty triangles, rebuilt every
// frame, is the whole cost.
export const CROWD = {
  count: 46,           // walkers in the pool
  spawn: 95,           // metres: where a free one is allowed to appear
  keep: 150,           // and where it gives its seat back
  draw: 135,
  detail: 55,          // past this, no hat, bag, umbrella or dog
  netEvery: 1.4,       // seconds between rebuilds of the pavement network
  speed: [0.95, 1.65], // metres per second -- a real pavement is 1.2 to 1.5
  stride: 3.6,
  swing: 0.52,         // radians of leg swing at the hip
  // Which road classes count as a pavement. A crowd walking down the middle of
  // Burnside is worse than no crowd at all.
  on: new Set(['sidewalk', 'footway', 'path', 'pedestrian', 'steps', 'crosswalk']),
  skin: [0xe8c4a2, 0xd9a882, 0xb07a52, 0x8a5a3a, 0x5f3d28, 0xf0d6bb],
  hair: [0x2b2118, 0x3d2c1d, 0x6b4a2a, 0x8a6a3a, 0xb8b0a6, 0x1a1a1c],
  // Portland dresses in flannel, rain shells, hi-vis, black and thrifted
  // colour. A crowd in one palette reads as a crowd of clones.
  tops: [0x8a3b32, 0x2f4a63, 0x3c5a3a, 0x1f2024, 0xb5643c, 0x53406b,
         0xc9a23c, 0x7a7f86, 0xd7d2c6, 0x2d6b6b, 0x9c4a6a, 0x4a3b2c],
  legs: [0x36445c, 0x23262b, 0x4a4438, 0x2f3a46, 0x6a6154, 0x1c2733],
  bags: [0x2b2f36, 0x5c4a34, 0x3d5a46, 0x7a3b3b, 0x2f4a63],
  brollies: [0x1f2024, 0x8a3b32, 0x2f4a63, 0xc9a23c, 0x3c5a3a],
  dogs: [0x5c4a34, 0x2b2118, 0xd7cbb4, 0x8a7a5a, 0x3a3a3c],
  hatOdds: 0.30, bagOdds: 0.34, brollyOdds: 0.11, dogOdds: 0.06,
};

// Per-prop LOD. `hero.js` swaps the nearest few dozen props for a better
// version of themselves INSIDE the chunk's merged buffer, and draws them in
// one extra call.
//
// THE COUNT IS THE BUDGET AND IT IS SMALL ON PURPOSE. A hero tree is about a
// hundred and forty triangles against fourteen, and a hero car a hundred and
// sixty against thirty -- so forty of them is roughly six thousand triangles,
// which is one per cent of a frame here. Raising it past a hundred stops being
// LOD and starts being "draw everything twice".
export const HERO = {
  count: 44,
  range: 46,           // metres. Past this the low version is the truth anyway
  every: 0.30,         // seconds between re-picks; the set changes as you walk
  // Which kinds have a better version to swap to. A hydrant is already four
  // triangles of the right shape and there is nothing to add to it.
  on: new Set(['tree', 'tree_conifer', 'street_lamp', 'bench', 'picnic_table',
               'car']),
};

export const STREAM = {
  full: 480, mid: 1050, keep: 1250,
  perFrame: 1,          // chunks built per frame, so a hitch is never two chunks long
  fetchAhead: 6,
};

// ---------------------------------------------------------------------------
// Ambient life: traffic, boats, aircraft.
//
// ONE BUDGET, DELIBERATELY SMALL. The brief was "a plane, boats, cars -- I
// don't want to get super heavy", and the honest reading of that is that none
// of this is the game: it is what stops the city looking like a photograph of
// itself. So the whole layer is boxes in the crowd's merged-geometry trick --
// one draw call for every vehicle, every hull and every aircraft on screen --
// and the counts below are what a phone can carry without noticing.
// ---------------------------------------------------------------------------
export const TRAFFIC = {
  count: 30,           // cars in the pool
  spawn: 130,          // metres: where a free one may appear
  keep: 230,           // and where it gives its seat back
  draw: 200,
  speed: [7.0, 13.5],  // m/s -- 25 to 30 mph, which is what these streets are
  slow: 0.55,          // how much of that a residential street gets
  // Which road classes carry traffic. A car on a footway is worse than no car.
  on: new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary',
               'residential', 'unclassified', 'living_street']),
  // Portland drives on the RIGHT, so a car sits to the right of the centreline
  // in its direction of travel. Getting this backwards is a head-on collision
  // with every other car on the street and it reads instantly.
  lane: 0.26,          // fraction of the carriageway width, off the centre
  len: 4.3, wide: 1.78, tall: 1.44,
  // Close enough to see a wheel is a wheel. Past this a tyre is under two
  // pixels and a dark sill says the same thing for a tenth of the triangles.
  hero: 38, wheelR: 0.33, axle: 0.045,
  // A sixth of the fleet is a van or a bus, because a street of identical
  // saloons is as obviously repeated as a crowd of identical people.
  bigOdds: 0.17, bigLen: 8.4, bigTall: 2.9,
  bigColors: [0xe8e6e0, 0x3f5d8a, 0x7a8a92, 0x2f3338, 0xb4b8bc],
};

export const BOATS = {
  count: 7,
  draw: 1400,          // a river is a long view; a boat two bridges away counts
  speed: [2.2, 6.5],
  // A tug on the Willamette is 25 m and a runabout is 6. The spread is the
  // point -- one size of boat reads as a decal.
  len: [6, 30], beam: [2.2, 8.5],
  hull: [0xd8d5cc, 0x2c4a63, 0x6e7378, 0x37503f, 0x8a3b32, 0x1f2024],
  deck: [0xb9b2a2, 0x54585e, 0xd7d2c6],
  wake: 0x9fb3b8,
  lane: 0.55,          // fraction of the half width a boat may use
};

// The airport is a real place at a real bearing, and it is OUTSIDE the play
// area -- PDX is six kilometres north-east of the Burnside Bridge. Nothing
// about it is modelled; what it buys is a direction for an approach to come
// from, so a plane crosses the sky going somewhere instead of on a loop.
export const AIR = {
  airport: [45.5887, -122.5975],   // PDX, runway 10R/28L
  plane: {
    every: [26, 70],     // seconds between passes
    span: 4200,          // metres of track flown
    y0: 900, y1: 260,    // it DESCENDS: an approach that holds altitude is a
                         // plane going somewhere else, and reads as a sticker
    speed: 82,
    len: 34, wing: 32, body: 0xe6e8ea, tail: 0x2f4a63,
  },
  heli: {
    radius: 620, y: 250, speed: 26,   // a news chopper, orbiting downtown
    // THE ROTOR HAS TO BE PALE. A real one is a translucent blur, and there is
    // no translucency to be had in a single opaque merged mesh -- so what is
    // left to read it with is VALUE, against a pale sky, and a dark grey rotor
    // on a dark body is one black blob at any distance. Measured off a shot at
    // 180 m: the blades were there and invisible.
    len: 15, body: 0x33383f, rotor: 0xc4cbd1, rpm: 4.2,
  },
};
