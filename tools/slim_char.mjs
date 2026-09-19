// Cut a character GLB down to the clips this game actually plays.
//
// The Shredworld export is 10.2 MB and 51 animations -- skate pushes, rifle
// strafes, bar swings, six dances. A city where you walk needs about ten of
// them, and an animation is keyframes on sixty-five bones: dropping forty-one
// of them is most of the file. The TEXTURES are kept exactly as they are, at
// their authored size: they are what makes him look like himself, and that is
// the whole reason for taking this export over the slimmer old one.
//
//   node tools/slim_char.mjs <in.glb> <out.glb> [clip ...]
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup } from '@gltf-transform/functions';
import draco3d from 'draco3dgltf';
import fs from 'node:fs';

const [, , inPath, outPath, ...want] = process.argv;
if (!inPath || !outPath) { console.error('usage: slim_char.mjs in.glb out.glb [clip ...]'); process.exit(1); }

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});

const doc = await io.read(inPath);
const root = doc.getRoot();
const keep = new Set(want);
const anims = root.listAnimations();
let dropped = 0;
for (const a of anims) {
  if (keep.size && keep.has(a.getName())) continue;
  if (!keep.size) continue;
  // An animation owns its samplers, and a sampler is where the keyframes live.
  // Disposing the animation alone leaves every accessor behind and `prune`
  // cannot always see they are orphaned -- the first cut here dropped 41 clips
  // and saved nothing at all.
  for (const ch of a.listChannels()) ch.dispose();
  for (const s of a.listSamplers()) s.dispose();
  a.dispose();
  dropped++;
}
await doc.transform(dedup(), prune({ keepLeaves: false, keepAttributes: false }));
await io.write(outPath, doc);
const before = fs.statSync(inPath).size, after = fs.statSync(outPath).size;
console.log(`${anims.length} clips -> ${root.listAnimations().length} (dropped ${dropped})`);
console.log(`${(before/1e6).toFixed(1)} MB -> ${(after/1e6).toFixed(1)} MB`);
console.log('kept:', root.listAnimations().map((a) => a.getName()).join(', '));
