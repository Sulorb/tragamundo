import * as THREE from 'three';
import { R, maskCanvas } from './geo.js';

export const MAX_HOLES = 24;

export function createGlobe(scene) {
  const tex = new THREE.CanvasTexture(maskCanvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;

  const holes = [];
  const holeCol = [];
  for (let i = 0; i < MAX_HOLES; i++) { holes.push(new THREE.Vector4(0, 1, 0, 0)); holeCol.push(new THREE.Vector3(1, 1, 1)); }

  const uniforms = {
    map: { value: tex },
    holes: { value: holes },
    holeCol: { value: holeCol },
    holeCount: { value: 0 },
    sunDir: { value: new THREE.Vector3(1, 1, 1).normalize() },
    time: { value: 0 },
  };

  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      varying vec3 vObj;
      void main(){
        vObj = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);
      }`,
    fragmentShader: /* glsl */ `
      #define PI 3.14159265
      #define MAXH ${MAX_HOLES}
      uniform sampler2D map;
      uniform vec4 holes[MAXH];
      uniform vec3 holeCol[MAXH];
      uniform int holeCount;
      uniform vec3 sunDir;
      uniform float time;
      varying vec3 vObj;
      float hash(vec3 p){ p = fract(p*0.3183099+.1); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
      float noise(vec3 x){
        vec3 i = floor(x); vec3 f = fract(x); f = f*f*(3.0-2.0*f);
        return mix(mix(mix(hash(i+vec3(0,0,0)),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
      }
      void main(){
        vec3 p = normalize(vObj);
        float lon = atan(-p.z, p.x);
        float lat = asin(clamp(p.y,-1.0,1.0));
        vec2 uv = vec2(lon/(2.0*PI)+0.5, lat/PI+0.5);
        vec4 m = texture2D(map, uv);
        float land = smoothstep(0.3,0.7,m.r);
        float coast = m.g;
        float n = noise(p*38.0)*0.6 + noise(p*110.0)*0.4;
        float n2 = noise(p*9.0);
        vec3 deep = vec3(0.03,0.16,0.40);
        vec3 shallow = vec3(0.10,0.52,0.72);
        vec3 ocean = mix(deep, shallow, smoothstep(0.0,0.95,coast));
        ocean += 0.03*sin(time*1.5 + n*12.0);
        float alat = abs(lat)*180.0/PI;
        vec3 grass = vec3(0.40,0.66,0.30);
        vec3 forest = vec3(0.20,0.46,0.22);
        vec3 desert = vec3(0.88,0.77,0.50);
        vec3 snow = vec3(0.94,0.97,1.0);
        vec3 lc = mix(grass, forest, smoothstep(0.35,0.75,n));
        float des = smoothstep(10.0,18.0,alat)*(1.0-smoothstep(30.0,38.0,alat))*smoothstep(0.42,0.6,n2);
        lc = mix(lc, desert, des);
        lc = mix(lc, snow, smoothstep(60.0,68.0,alat + n*8.0));
        vec3 col = mix(ocean, lc, land);
        // playa
        col = mix(col, vec3(0.93,0.86,0.62), land*(1.0-smoothstep(0.55,0.75,coast))*0.0);
        float diff = max(dot(p, sunDir), 0.0);
        col *= 0.45 + 0.75*diff;
        // huecos
        for (int i = 0; i < MAXH; i++) {
          if (i >= holeCount) break;
          vec4 h = holes[i];
          float ang = acos(clamp(dot(p, h.xyz), -1.0, 1.0));
          float t = ang / h.w;
          if (t < 1.0) {
            vec3 inner = vec3(0.01,0.01,0.025) + holeCol[i]*0.10*pow(t,5.0);
            inner += vec3(0.25)*pow(t,14.0);
            col = inner;
          } else if (t < 1.10) {
            float k = 1.0 - (t-1.0)/0.10;
            col = mix(col, holeCol[i]*1.15, k*k*0.95);
          }
        }
        gl_FragColor = vec4(col,1.0);
      }`,
  });

  const globe = new THREE.Mesh(new THREE.SphereGeometry(R, 192, 128), mat);
  scene.add(globe);

  // Atmósfera
  const atm = new THREE.Mesh(
    new THREE.SphereGeometry(R * 1.06, 96, 64),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main(){ vec4 wp = modelMatrix*vec4(position,1.0); vN = normalize(mat3(modelMatrix)*normal); vV = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix*viewMatrix*wp; }`,
      fragmentShader: `varying vec3 vN; varying vec3 vV;
        void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); gl_FragColor = vec4(vec3(0.35,0.6,1.0)*f*1.4, f); }`,
    })
  );
  scene.add(atm);

  // Estrellas
  const N = 4000, sp = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const v = new THREE.Vector3().randomDirection().multiplyScalar(900 + Math.random() * 600);
    sp.set([v.x, v.y, v.z], i * 3);
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  scene.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false })));

  return {
    globe, uniforms,
    setHoles(list) {
      const n = Math.min(list.length, MAX_HOLES);
      for (let i = 0; i < n; i++) {
        const h = list[i];
        holes[i].set(h.pos.x, h.pos.y, h.pos.z, Math.max(0.0005, h.r / R));
        holeCol[i].set(h.color.r, h.color.g, h.color.b);
      }
      uniforms.holeCount.value = n;
    },
  };
}
