import { tgpu } from 'typegpu';
import * as d from 'typegpu/data';

import {
  AMBIENT,
  BLUR_WGSL,
  COMPOSITE_WGSL,
  COUNT,
  DRAW_WGSL,
  Emitter,
  PARAM_FLOATS,
  Params,
  Particle,
  SIM_WGSL,
  WORKGROUP,
} from './dustShaders';

/**
 * WebGPU objects of the light layer. Built once on the JS thread; the per-frame encoding
 * (`encodeFrame`) runs on the Reanimated UI thread. No React Native imports here, so the same
 * code runs headless (shader validation / reference renders) outside the app.
 */

const HDR: GPUTextureFormat = 'rgba16float';
/** Bloom pyramid depth below the core (each level is half the previous one). */
export const BLOOM_LEVELS = 4;

export type DustGpu = {
  device: GPUDevice;
  params: GPUBuffer;
  sim: GPUComputePipeline;
  simGroup: GPUBindGroup;
  /** particles → canvas (motes; clamped, premultiplied) */
  drawLdr: GPURenderPipeline;
  /** particles → HDR core texture (bursts; unclamped radiance) */
  drawHdr: GPURenderPipeline;
  drawGroup: GPUBindGroup;
  down: GPURenderPipeline;
  up: GPURenderPipeline;
  composite: GPURenderPipeline;
  blurLayout: GPUBindGroupLayout;
  compLayout: GPUBindGroupLayout;
  sampler: GPUSampler;
  /** owned buffers (released with `destroyDustGpu`) */
  buffers: GPUBuffer[];
};

export type DustTargets = {
  /** offscreen passes, in order: core, downs (core→L1…L3→L4), ups (L4→L3…L2→L1) */
  core: GPURenderPassDescriptor;
  downs: GPURenderPassDescriptor[];
  downGroups: GPUBindGroup[];
  ups: GPURenderPassDescriptor[];
  upGroups: GPUBindGroup[];
  compGroup: GPUBindGroup;
  /** owned textures (released with `destroyDustTargets`) */
  textures: GPUTexture[];
};

type Warn = (message: string) => void;

const ADDITIVE: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

/** Logs WGSL compiler messages with the offending line (the generated struct header shifts line numbers). */
async function reportCompilation(module: GPUShaderModule, code: string, name: string, warn: Warn) {
  let errors = 0;
  try {
    const info = await module.getCompilationInfo();
    const lines = code.split('\n');
    for (const m of info.messages) {
      if (m.type === 'info') continue;
      if (m.type === 'error') errors++;
      const src = lines[m.lineNum - 1]?.trim() ?? '';
      warn(`[GoldDust] WGSL ${m.type} in ${name} ${m.lineNum}:${m.linePos}: ${m.message}\n    > ${src}`);
    }
  } catch (e) {
    warn(`[GoldDust] getCompilationInfo(${name}) unavailable: ${String(e)}`);
  }
  return errors;
}

/**
 * Builds buffers, layouts and pipelines inside device error scopes. Resolves to null (and warns
 * with a "[GoldDust]" prefix) on any WGSL / validation / OOM error, so the caller can fall back
 * to rendering nothing instead of spamming errors every frame.
 */
export async function createDustGpu(
  device: GPUDevice,
  canvasFormat: GPUTextureFormat,
  warn: Warn,
): Promise<DustGpu | null> {
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');

  const root = tgpu.initFromDevice({ device });
  const particleBuffer = root.createBuffer(d.arrayOf(Particle, COUNT)).$usage('storage');
  const paramsBuffer = root.createBuffer(Params).$usage('uniform');
  if (d.sizeOf(Params) !== PARAM_FLOATS * 4) {
    warn(`[GoldDust] Params layout mismatch: ${d.sizeOf(Params)} bytes, expected ${PARAM_FLOATS * 4}`);
  }
  const particles = root.unwrap(particleBuffer);
  const params = root.unwrap(paramsBuffer);

  // TypeGPU resolves the schemas into WGSL struct declarations and links them into the
  // hand-written shaders (identifiers `Particle` / `Emitter` / `Params` → generated declarations).
  const externals = { Particle, Emitter, Params };
  const simCode = tgpu.resolve({ template: SIM_WGSL, externals });
  const drawCode = tgpu.resolve({ template: DRAW_WGSL, externals });
  const compCode = tgpu.resolve({ template: COMPOSITE_WGSL, externals });
  const blurCode = BLUR_WGSL;

  const simModule = device.createShaderModule({ label: 'dust-sim', code: simCode });
  const drawModule = device.createShaderModule({ label: 'dust-draw', code: drawCode });
  const compModule = device.createShaderModule({ label: 'dust-composite', code: compCode });
  const blurModule = device.createShaderModule({ label: 'dust-blur', code: blurCode });

  const S = GPUShaderStage;
  const simLayout = device.createBindGroupLayout({
    label: 'dust-sim',
    entries: [
      { binding: 0, visibility: S.COMPUTE, buffer: { type: 'storage' } },
      { binding: 1, visibility: S.COMPUTE, buffer: { type: 'uniform' } },
    ],
  });
  const drawLayout = device.createBindGroupLayout({
    label: 'dust-draw',
    entries: [
      { binding: 0, visibility: S.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 1, visibility: S.VERTEX | S.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const blurLayout = device.createBindGroupLayout({
    label: 'dust-blur',
    entries: [
      { binding: 0, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const compLayout = device.createBindGroupLayout({
    label: 'dust-composite',
    entries: [
      { binding: 0, visibility: S.FRAGMENT, sampler: { type: 'filtering' } },
      { binding: 1, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 2, visibility: S.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 3, visibility: S.FRAGMENT, buffer: { type: 'uniform' } },
    ],
  });
  const pl = (layout: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [layout] });

  const sim = device.createComputePipeline({
    label: 'dust-sim',
    layout: pl(simLayout),
    compute: { module: simModule, entryPoint: 'main' },
  });
  const drawPipeline = (entryPoint: string, format: GPUTextureFormat) =>
    device.createRenderPipeline({
      label: `dust-${entryPoint}`,
      layout: pl(drawLayout),
      vertex: { module: drawModule, entryPoint: 'vs' },
      fragment: { module: drawModule, entryPoint, targets: [{ format, blend: ADDITIVE }] },
      primitive: { topology: 'triangle-list' },
    });
  const drawLdr = drawPipeline('fsLdr', canvasFormat);
  const drawHdr = drawPipeline('fsHdr', HDR);
  const fullscreen = (
    module: GPUShaderModule,
    entryPoint: string,
    layout: GPUBindGroupLayout,
    format: GPUTextureFormat,
    blend?: GPUBlendState,
  ) =>
    device.createRenderPipeline({
      label: `dust-${entryPoint}`,
      layout: pl(layout),
      vertex: { module, entryPoint: 'vsFull' },
      fragment: { module, entryPoint, targets: [blend ? { format, blend } : { format }] },
      primitive: { topology: 'triangle-list' },
    });
  const down = fullscreen(blurModule, 'fsDown', blurLayout, HDR);
  const up = fullscreen(blurModule, 'fsUp', blurLayout, HDR, ADDITIVE);
  const composite = fullscreen(compModule, 'fsComposite', compLayout, canvasFormat, ADDITIVE);

  const sampler = device.createSampler({
    label: 'dust-linear',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const simGroup = device.createBindGroup({
    label: 'dust-sim',
    layout: simLayout,
    entries: [
      { binding: 0, resource: { buffer: particles } },
      { binding: 1, resource: { buffer: params } },
    ],
  });
  const drawGroup = device.createBindGroup({
    label: 'dust-draw',
    layout: drawLayout,
    entries: [
      { binding: 0, resource: { buffer: particles } },
      { binding: 1, resource: { buffer: params } },
    ],
  });

  const compileErrors =
    (await reportCompilation(simModule, simCode, 'sim', warn)) +
    (await reportCompilation(drawModule, drawCode, 'draw', warn)) +
    (await reportCompilation(compModule, compCode, 'composite', warn)) +
    (await reportCompilation(blurModule, blurCode, 'blur', warn));
  const oom = await device.popErrorScope();
  const invalid = await device.popErrorScope();
  if (oom) warn(`[GoldDust] out of memory while building the light layer: ${oom.message}`);
  if (invalid) warn(`[GoldDust] validation error while building the light layer: ${invalid.message}`);
  // TypeGPU's root only caches helpers; the buffers are ours to release
  root.destroy();
  if (oom || invalid || compileErrors > 0) {
    particles.destroy();
    params.destroy();
    return null;
  }

  return {
    device,
    params,
    sim,
    simGroup,
    drawLdr,
    drawHdr,
    drawGroup,
    down,
    up,
    composite,
    blurLayout,
    compLayout,
    sampler,
    buffers: [particles, params],
  };
}

export function destroyDustGpu(g: DustGpu) {
  for (const b of g.buffers) b.destroy();
}

/**
 * Offscreen HDR targets for a view of `widthPt` × `heightPt` points: the burst core at
 * `coreScale` px/pt, then a bloom pyramid of BLOOM_LEVELS halvings.
 */
export function createDustTargets(
  g: DustGpu,
  widthPt: number,
  heightPt: number,
  coreScale: number,
  warn: Warn,
): DustTargets | null {
  const { device } = g;
  device.pushErrorScope('validation');
  const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
  const textures: GPUTexture[] = [];
  const views: GPUTextureView[] = [];
  let w = Math.max(1, Math.ceil(widthPt * coreScale));
  let h = Math.max(1, Math.ceil(heightPt * coreScale));
  for (let level = 0; level <= BLOOM_LEVELS; level++) {
    const tex = device.createTexture({ label: `dust-hdr-${level}`, size: [w, h], format: HDR, usage });
    textures.push(tex);
    views.push(tex.createView());
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
  }
  const pass = (view: GPUTextureView, loadOp: GPULoadOp): GPURenderPassDescriptor => ({
    colorAttachments: [{ view, loadOp, storeOp: 'store', clearValue: [0, 0, 0, 0] }],
  });
  const blurGroup = (src: GPUTextureView) =>
    device.createBindGroup({
      layout: g.blurLayout,
      entries: [
        { binding: 0, resource: g.sampler },
        { binding: 1, resource: src },
      ],
    });
  const downs: GPURenderPassDescriptor[] = [];
  const downGroups: GPUBindGroup[] = [];
  for (let level = 1; level <= BLOOM_LEVELS; level++) {
    downs.push(pass(views[level], 'clear'));
    downGroups.push(blurGroup(views[level - 1]));
  }
  // progressive upsampling: each level gets the blurred level below it added on top (load + add)
  const ups: GPURenderPassDescriptor[] = [];
  const upGroups: GPUBindGroup[] = [];
  for (let level = BLOOM_LEVELS - 1; level >= 1; level--) {
    ups.push(pass(views[level], 'load'));
    upGroups.push(blurGroup(views[level + 1]));
  }
  const compGroup = device.createBindGroup({
    layout: g.compLayout,
    entries: [
      { binding: 0, resource: g.sampler },
      { binding: 1, resource: views[0] },
      { binding: 2, resource: views[1] },
      { binding: 3, resource: { buffer: g.params } },
    ],
  });
  const targets: DustTargets = {
    core: pass(views[0], 'clear'),
    downs,
    downGroups,
    ups,
    upGroups,
    compGroup,
    textures,
  };
  device.popErrorScope().then(
    (e) => {
      if (e) warn(`[GoldDust] validation error while creating bloom targets: ${e.message}`);
    },
    () => {},
  );
  return targets;
}

export function destroyDustTargets(t: DustTargets) {
  for (const tex of t.textures) tex.destroy();
}

/** Reused per-frame scratch for `encodeFrame` (lives on the UI runtime, never reallocated). */
export type FrameScratch = {
  canvasAttachment: GPURenderPassColorAttachment | null;
  canvasPass: GPURenderPassDescriptor | null;
  submit: GPUCommandBuffer[];
};

export function makeFrameScratch(): FrameScratch {
  'worklet';
  return { canvasAttachment: null, canvasPass: null, submit: [] };
}

function canvasPassFor(s: FrameScratch, view: GPUTextureView) {
  'worklet';
  if (s.canvasAttachment === null || s.canvasPass === null) {
    s.canvasAttachment = { view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] };
    s.canvasPass = { colorAttachments: [s.canvasAttachment] };
  } else {
    s.canvasAttachment.view = view;
  }
  return s.canvasPass;
}

/**
 * One frame: params upload → compute (motes only, or the whole pool while a burst lives) →
 * [bursts → HDR core → bloom down/up chain] → canvas: composite (core + bloom, tone-mapped) +
 * motes. With no live burst the offscreen work is skipped entirely.
 */
export function encodeFrame(
  g: DustGpu,
  tg: DustTargets,
  s: FrameScratch,
  paramsData: Float32Array,
  canvasView: GPUTextureView,
  bursts: boolean,
  motes: boolean,
  /** particles [0, live) may be alive (ring high-water mark) */
  live: number,
) {
  'worklet';
  const { device } = g;
  device.queue.writeBuffer(g.params, 0, paramsData);
  const enc = device.createCommandEncoder();

  const cp = enc.beginComputePass();
  cp.setPipeline(g.sim);
  cp.setBindGroup(0, g.simGroup);
  const n = bursts ? Math.min(Math.max(live, AMBIENT), COUNT) : AMBIENT;
  cp.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
  cp.end();

  if (bursts) {
    const core = enc.beginRenderPass(tg.core);
    core.setPipeline(g.drawHdr);
    core.setBindGroup(0, g.drawGroup);
    core.draw(6, n - AMBIENT, 0, AMBIENT);
    core.end();
    for (let k = 0; k < tg.downs.length; k++) {
      const p = enc.beginRenderPass(tg.downs[k]);
      p.setPipeline(g.down);
      p.setBindGroup(0, tg.downGroups[k]);
      p.draw(3);
      p.end();
    }
    for (let k = 0; k < tg.ups.length; k++) {
      const p = enc.beginRenderPass(tg.ups[k]);
      p.setPipeline(g.up);
      p.setBindGroup(0, tg.upGroups[k]);
      p.draw(3);
      p.end();
    }
  }

  const pass = enc.beginRenderPass(canvasPassFor(s, canvasView));
  if (bursts) {
    pass.setPipeline(g.composite);
    pass.setBindGroup(0, tg.compGroup);
    pass.draw(3);
  }
  if (motes) {
    pass.setPipeline(g.drawLdr);
    pass.setBindGroup(0, g.drawGroup);
    pass.draw(6, AMBIENT, 0, 0);
  }
  pass.end();
  s.submit[0] = enc.finish();
  device.queue.submit(s.submit);
}

/** Clears the canvas once (going idle). */
export function encodeClear(g: DustGpu, s: FrameScratch, canvasView: GPUTextureView) {
  'worklet';
  const enc = g.device.createCommandEncoder();
  enc.beginRenderPass(canvasPassFor(s, canvasView)).end();
  s.submit[0] = enc.finish();
  g.device.queue.submit(s.submit);
}
