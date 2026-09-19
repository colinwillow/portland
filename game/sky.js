// Sky, sun and fog -- the three things that decide what time of day it is.
//
// The stylised light/shade split is a HEMISPHERE LIGHT and nothing else: cool
// from above, warm bounce from below. That pair does for free what a toon ramp
// costs a shader patch to do, and on a city of flat-shaded boxes it is most of
// the look. There are no shadow maps: a projected shadow over a city this size
// is the most expensive thing that could be in here, and a flat-shaded box city
// reads perfectly well without one. What grounds things instead is the vertical
// gradient baked into every wall (WALL_AO).

import * as THREE from 'three';
import { SKY } from './tune.js';

export function makeSky(scene) {
  scene.background = new THREE.Color(SKY.horizon);
  scene.fog = new THREE.Fog(SKY.fogColor, SKY.fogNear, SKY.fogFar);

  const hemi = new THREE.HemisphereLight(SKY.ambientSky, SKY.ambientGround, SKY.ambientI);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(SKY.sun, SKY.sunI);
  const d = new THREE.Vector3(...SKY.sunDir).normalize();
  sun.position.copy(d).multiplyScalar(500);
  scene.add(sun);
  scene.add(sun.target);

  const fill = new THREE.DirectionalLight(SKY.fill, SKY.fillI);
  fill.position.set(...SKY.fillDir).normalize().multiplyScalar(500);
  scene.add(fill);

  // A dome rather than a flat background colour, so the horizon is a gradient
  // and the fog has something to fade INTO. BackSide, unlit, no depth write:
  // it is a backdrop, not a thing in the world.
  const g = new THREE.SphereGeometry(6000, 24, 14);
  const m = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(SKY.top) },
                bot: { value: new THREE.Color(SKY.horizon) } },
    vertexShader: `varying float vY; void main(){ vY = normalize(position).y;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 bot; varying float vY;
      void main(){ float t = clamp(vY*1.6+0.16, 0.0, 1.0);
        gl_FragColor = vec4(mix(bot, top, t*t), 1.0); }`,
  });
  const dome = new THREE.Mesh(g, m);
  dome.renderOrder = -2;
  dome.frustumCulled = false;
  scene.add(dome);
  return { sun, fill, hemi, dome };
}
