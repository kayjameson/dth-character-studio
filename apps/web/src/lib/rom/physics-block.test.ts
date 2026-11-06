import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'

import { describe, expect, it } from 'vitest'

/**
 * The physics (PHY) preset block's two fences (runtime v107).
 *
 * A pose preset keys only inside its own range, and DTH's `G9 Physics
 * Example.duf` (43 frames, 23 `dth_phy_*` channels — parsed 2026-11-06) runs
 * past both ends of it:
 *   - HEAD: `dth_phy_breast_out_l` is keyed (0,1),(1,1),(2,0),… relative to
 *     the block start; every other channel starts (0,0). Loaded at frame 432,
 *     Daz's implicit frame-0 key plus the LINEAR stamp made that a 0→1 ramp
 *     across every JCM/FAC/GEN frame — a left-breast delta baked into every
 *     shape Houdini derived from them.
 *   - TAIL: `dth_phy_stomach_hang` ends (41,0),(42,1) with no key after the
 *     last frame, so it held at 1 through every FBM/MISC frame and the
 *     close-out frame (seen on a real ROM: frame 475 = Emaciated + belly,
 *     476 = belly on the base).
 *
 * `ApplyPhysics` now fences both: `anchorBlockHeadKeys` keys each morph's
 * pre-block RAW value at startFrame-1 after the load, and
 * `closeDanglingMorphKeys` closes the tail at startFrame+43 against the root
 * figure's own baselines. The shipped `DthUtils.dsa` runs for real in a
 * sandbox (the harness of restore-zeroed-dials.test.ts) over fake properties
 * that model the two Daz facts the fences depend on — `setValue` of an
 * unchanged value makes no key, and the first key at t>0 on an unkeyed channel
 * gets an implicit (0, old value) companion — fed the REAL preset keys.
 *
 * What the fakes cannot prove: that Daz's own setValue / key timing behave as
 * modelled on a live build. The live steps for that are in the PR description.
 */

const TICKS = 160
const LINEAR = 0
const CONSTANT = 1
const PHYS_FRAMES = 43

/** The real relative keys of the stock preset, for the channels this file
 *  reasons about (parsed from the .duf at 30 fps; every key LINEAR). */
const DUF: Record<string, Array<[number, number]>> = {
  dth_phy_breast_out_l: [[0, 1], [1, 1], [2, 0], [6, 0], [7, 1], [8, 0]],
  dth_phy_breast_up_l: [[0, 0], [1, 1], [3, 1], [4, 0]],
  dth_phy_stomach_up: [[0, 0], [34, 0], [35, 1], [37, 1], [38, 0]],
  dth_phy_stomach_hang: [[0, 0], [41, 0], [42, 1]],
}

interface Key {
  t: number
  v: number
  interp: number
}

interface RawSnapshot {
  raw: boolean
  values: Record<string, number>
}

interface UtilsModule {
  memorizeBaseMorphs: (nodes: Array<unknown>) => Record<string, number>
  memorizeRawMorphsAtFrame0: (nodes: Array<unknown>) => RawSnapshot
  memorizeRawMorphsAtFrame: (nodes: Array<unknown>, frame: number) => RawSnapshot
  anchorBlockHeadKeys: (nodes: Array<unknown>, startFrame: number, pre: RawSnapshot | null) => number
  closeDanglingMorphKeys: (
    nodes: Array<unknown>,
    boundary: number,
    evaluated: Record<string, number> | null,
    raw: RawSnapshot | null,
    owned?: RawSnapshot,
  ) => void
  resetRunLog: () => void
  runLog: () => { errors: Array<string>; warnings: Array<string> }
}

/** A DzFloatProperty with a real key list. `dial` is the raw static value an
 *  unkeyed channel holds; `erc` an ERC controller's share, visible through
 *  getValue only (raw keeps it out — the whole point of the raw snapshots). */
class FakeProp {
  name: string
  dial: number
  erc: number
  keys: Array<Key> = []
  clamped = true
  /** Models a build/channel on which no key can be made (every write dropped). */
  refuses = false

  constructor(name: string, dial = 0, erc = 0) {
    this.name = name
    this.dial = dial
    this.erc = erc
  }

  getName() {
    return this.name
  }
  getLabel() {
    return `${this.name} label`
  }
  inherits(type: string) {
    return type === 'DzFloatProperty'
  }
  getNumControllers() {
    return this.erc === 0 ? 0 : 1
  }
  getMin() {
    return -1
  }
  getMax() {
    return 1
  }
  setIsClamped(on: boolean) {
    this.clamped = on
  }
  getNumKeys() {
    return this.keys.length
  }
  getKeyTime(i: number) {
    return this.keys[i].t
  }
  getKeyValue(i: number) {
    return this.keys[i].v
  }
  /** The raw animation value at `time`: held before the first key, LINEAR or
   *  CONSTANT between keys by the LEFT key's interpolation, held after the last. */
  getRawValue(time: number) {
    if (this.keys.length === 0) return this.dial
    const exact = this.keys.find((k) => k.t === time)
    if (exact) return exact.v
    if (time <= this.keys[0].t) return this.keys[0].v
    for (let i = 0; i < this.keys.length - 1; i++) {
      const a = this.keys[i]
      const b = this.keys[i + 1]
      if (time >= a.t && time <= b.t) {
        if (a.interp === CONSTANT) return a.v
        return a.v + ((b.v - a.v) * (time - a.t)) / (b.t - a.t)
      }
    }
    return this.keys[this.keys.length - 1].v
  }
  getValue(time: number) {
    return this.getRawValue(time) + this.erc
  }
  /** Daz's setValue as measured: a no-op when the value already IS `value`
   *  (returns false, no key), else a key at `time` — and the first key at t>0
   *  on a never-keyed channel brings an implicit (0, old value) key with it. */
  setValue(time: number, value: number, interp = LINEAR) {
    if (this.refuses) return false
    if (Math.abs(this.getRawValue(time) - value) < 1e-9) return false
    this.putKey(time, value, interp)
    return true
  }
  /** A preset load writes keys outright (no no-op rule — these are the
   *  preset's own keys), still with Daz's implicit frame-0 companion. */
  loadKey(time: number, value: number) {
    this.putKey(time, value, LINEAR)
  }
  private putKey(time: number, value: number, interp: number) {
    if (this.keys.length === 0 && time > 0) this.keys.push({ t: 0, v: this.dial, interp })
    const existing = this.keys.find((k) => k.t === time)
    if (existing) {
      existing.v = value
      existing.interp = interp
    } else {
      this.keys.push({ t: time, v: value, interp })
      this.keys.sort((a, b) => a.t - b.t)
    }
  }
  /** [frame, value] pairs, the way a .duf dump reads. */
  frames(): Array<[number, number]> {
    return this.keys.map((k) => [k.t / TICKS, k.v])
  }
  at(frame: number) {
    return this.getValue(frame * TICKS)
  }
}

function figure(name: string, props: Array<FakeProp>) {
  const mods = props.map((p) => ({
    getName: () => p.name,
    inherits: (t: string) => t === 'DzMorph',
    getValueControl: () => p,
  }))
  return {
    getName: () => name,
    getLabel: () => name,
    getObject: () => ({
      getNumModifiers: () => mods.length,
      getModifier: (i: number) => mods[i] ?? null,
    }),
    getNumProperties: () => 0,
    getProperty: () => null,
  }
}

function loadUtils(): { utils: UtilsModule; printed: () => string } {
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'runtime')
  const src = readFileSync(join(dir, 'DthUtils.dsa'), 'utf8')
  const lines: Array<string> = []
  const utils = runInNewContext(
    `${src}\n;({
      memorizeBaseMorphs: memorizeBaseMorphs,
      memorizeRawMorphsAtFrame0: memorizeRawMorphsAtFrame0,
      memorizeRawMorphsAtFrame: memorizeRawMorphsAtFrame,
      anchorBlockHeadKeys: anchorBlockHeadKeys,
      closeDanglingMorphKeys: closeDanglingMorphKeys,
      resetRunLog: resetRunLog,
      runLog: function(){ return DTH_RUN_LOG }
    })`,
    {
      print: (...args: Array<unknown>) => lines.push(args.map(String).join(' ')),
      Math,
      Date,
      JSON,
      DzFloatProperty: { LINEAR_INTERP: LINEAR, CONSTANT_INTERP: CONSTANT, TCB_INTERP: 2 },
      DzProperty: { InterpLinear: LINEAR, InterpConstant: CONSTANT },
      Scene: {
        setDefaultKeyInterpolationType: () => {},
        getTimeStep: () => TICKS,
      },
    },
  ) as UtilsModule
  utils.resetRunLog()
  return { utils, printed: () => lines.join('\n') }
}

/** What loadPreset(physRom, root, startFrame) leaves behind: the preset's
 *  keys at startFrame + relative. */
function loadPhysicsPreset(props: Array<FakeProp>, startFrame: number) {
  for (const p of props) {
    const keys = DUF[p.name]
    if (!keys) continue
    for (const [rel, v] of keys) p.loadKey((startFrame + rel) * TICKS, v)
  }
}

/** The root figure a G9 character brings to the PHY block (base 0–327, GP
 *  328–431, PHY at 432): the four preset channels, a base-ROM pose the base
 *  close-out already closed at 328, and the three kinds of character-owned
 *  dial the root close-out must never touch. */
function g9Root() {
  const props = {
    breastOut: new FakeProp('dth_phy_breast_out_l'),
    breastUp: new FakeProp('dth_phy_breast_up_l'),
    stomachUp: new FakeProp('dth_phy_stomach_up'),
    stomachHang: new FakeProp('dth_phy_stomach_hang'),
    neckPose: new FakeProp('facs_bs_NeckUnderChin'),
    owned: new FakeProp('ProportionHeight', 0.5),
    cancelled: new FakeProp('MB_Quella_Body_bs_body', -1, 1), // raw -1 + control +1 = 0
    driven: new FakeProp('CJ_Head_bs_Head', 0, 1), // raw 0, a control's +1
  }
  props.neckPose.loadKey(327 * TICKS, 1)
  props.neckPose.loadKey(328 * TICKS, 0)
  return { props, root: figure('Genesis9', Object.values(props)) }
}

/** ApplyPhysics' fence sequence, minus the Daz calls: the snapshots the
 *  workflow takes before any preset loads, the pre-block raw read, the load,
 *  then the head anchor and the tail close. */
function runPhysicsBlock(utils: UtilsModule, root: unknown, props: Array<FakeProp>, startFrame: number) {
  const base = utils.memorizeBaseMorphs([root])
  const rootRaw = utils.memorizeRawMorphsAtFrame0([root])
  const pre = startFrame > 0 ? utils.memorizeRawMorphsAtFrame([root], startFrame - 1) : null
  loadPhysicsPreset(props, startFrame)
  const anchored = utils.anchorBlockHeadKeys([root], startFrame, pre)
  utils.closeDanglingMorphKeys([root], startFrame + PHYS_FRAMES, base, null, rootRaw)
  return anchored
}

describe('physics block fences (runtime v107)', () => {
  it('HEAD: a morph the preset starts non-zero gets its pre-block value keyed on the frame before the block', () => {
    const { utils } = loadUtils()
    const { props, root } = g9Root()
    // The bug's shape first: loaded bare, breast_out_l ramps in from frame 0.
    loadPhysicsPreset(Object.values(props), 432)
    expect(props.breastOut.frames().slice(0, 2)).toEqual([[0, 0], [432, 1]])
    expect(props.breastOut.at(216)).toBeCloseTo(0.5, 5)

    const { props: p2, root: root2 } = g9Root()
    const anchored = runPhysicsBlock(utils, root2, Object.values(p2), 432)
    expect(anchored).toBe(1)
    // The user's 11:36 dump, plus the (431, 0) that was missing from it.
    expect(p2.breastOut.frames()).toEqual([[0, 0], [431, 0], [432, 1], [433, 1], [434, 0], [438, 0], [439, 1], [440, 0]])
    for (const frame of [1, 100, 216, 327, 328, 431]) expect(p2.breastOut.at(frame)).toBe(0)
    expect(p2.breastOut.at(432)).toBe(1)
    void root
  })

  it('HEAD: a morph the preset starts at its pre-block value is left alone — the dump of the 22 others', () => {
    const { utils } = loadUtils()
    const { props, root } = g9Root()
    runPhysicsBlock(utils, root, Object.values(props), 432)
    // Exactly the keys the user's ROM .duf dump showed for breast_up_l.
    expect(props.breastUp.frames()).toEqual([[0, 0], [432, 0], [433, 1], [435, 1], [436, 0]])
    expect(props.stomachUp.frames()).toEqual([[0, 0], [432, 0], [466, 0], [467, 1], [469, 1], [470, 0]])
    // No stray head key anywhere else on the figure.
    for (const p of Object.values(props)) {
      if (p !== props.breastOut) expect(p.frames().some(([f]) => f === 431), p.name).toBe(false)
    }
  })

  it('TAIL: the last pose is closed on the first post-block frame, at its baseline', () => {
    const { utils, printed } = loadUtils()
    // The bug's shape first (v26–v106: ApplyPhysics ran no close-out): the
    // belly holds at 1 on the frame after the block and on every frame after.
    const bare = g9Root()
    loadPhysicsPreset(Object.values(bare.props), 432)
    expect(bare.props.stomachHang.frames()).toEqual([[0, 0], [432, 0], [473, 0], [474, 1]])
    expect([bare.props.stomachHang.at(475), bare.props.stomachHang.at(476)]).toEqual([1, 1])

    const { props, root } = g9Root()
    runPhysicsBlock(utils, root, Object.values(props), 432)
    expect(props.stomachHang.frames()).toEqual([[0, 0], [432, 0], [473, 0], [474, 1], [475, 0]])
    expect(props.stomachHang.at(474)).toBe(1)
    expect(props.stomachHang.at(475)).toBe(0)
    expect(props.stomachHang.at(476)).toBe(0)
    expect(printed()).toContain('Closed 1 dangling morph key(s) at frame 475')
  })

  it('PHY as the LAST block: the close lands on the range-end frame the block itself reserved — nothing past it', () => {
    const { utils } = loadUtils()
    const { props, root } = g9Root()
    runPhysicsBlock(utils, root, Object.values(props), 432)
    // setTotalFrames(startFrame + physFrameCount) puts frame 475 on the
    // timeline before the load (pinned textually below), so the close-out has
    // a frame to land on without lengthening the ROM.
    const lastKey = Math.max(...Object.values(props).flatMap((p) => p.frames().map(([f]) => f)))
    expect(lastKey).toBe(432 + PHYS_FRAMES)
    for (const p of Object.values(props)) {
      if (p.name.startsWith('dth_phy_')) expect(p.at(475), p.name).toBe(0)
    }
    const workflow = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'runtime', 'DthWorkflow.dsa'),
      'utf8',
    )
    const body = workflow.slice(workflow.indexOf('function ApplyPhysics('))
    const reserve = body.indexOf('setTotalFrames(startFrame + physFrameCount);')
    const load = body.indexOf('loadPreset(sPhysROM, oNodeRoot, startFrame)')
    const snapshot = body.indexOf('memorizeRawMorphsAtFrame([oNodeRoot], startFrame - 1)')
    const anchor = body.indexOf('anchorBlockHeadKeys([oNodeRoot], startFrame, oPreBlock);')
    const close = body.indexOf(
      'closeDanglingMorphKeys([oNodeRoot], startFrame + physFrameCount, baseMorphValues, null, rootRawBase);',
    )
    for (const at of [reserve, load, snapshot, anchor, close]) expect(at).toBeGreaterThan(-1)
    // Reserve the frame, read the pre-block state, load, then fence both ends.
    expect(reserve).toBeLessThan(snapshot)
    expect(snapshot).toBeLessThan(load)
    expect(load).toBeLessThan(anchor)
    expect(anchor).toBeLessThan(close)
    // The baselines reach ApplyPhysics from the workflow's pre-ROM snapshots.
    expect(workflow).toContain('ApplyPhysics(options, oNodeRoot, startFrame, baseMorphValues, rootRawBase)')
  })

  it('PHY followed by FBM: the first custom frame shows the FBM shape alone, and the frame after it the base', () => {
    const { utils } = loadUtils()
    const { props, root } = g9Root()
    runPhysicsBlock(utils, root, Object.values(props), 432)
    // CreateFrameDatas starts the custom frames at the same
    // Scene.getAnimRange().end the close-out used (475), and createMorphFrame
    // sawtooths its morph 0 → 1 → 0 around that frame.
    const emaciated = new FakeProp('body_bs_Emaciated')
    emaciated.setValue(474 * TICKS, 0)
    emaciated.setValue(475 * TICKS, 1)
    emaciated.setValue(476 * TICKS, 0)
    expect([props.stomachHang.at(475), emaciated.at(475)]).toEqual([0, 1])
    expect([props.stomachHang.at(476), emaciated.at(476)]).toEqual([0, 0])
  })

  it('leaves character-owned dials alone at both fences, and anchors an owned dial the preset DOES key at its own value', () => {
    const { utils } = loadUtils()
    const { props, root } = g9Root()
    runPhysicsBlock(utils, root, Object.values(props), 432)
    // A plain dial, an ERC-cancelled dial (raw -1, value 0) and a purely
    // driven morph (raw 0, value 1): the preset never keys them, so the head
    // anchor skips them, and the tail close spares them by the same ownership
    // rule the base-ROM close-out uses (evaluated or raw base non-zero).
    expect(props.owned.frames()).toEqual([])
    expect(props.cancelled.frames()).toEqual([])
    expect(props.driven.frames()).toEqual([])
    // The base ROM's closed pose keeps exactly its closed keys.
    expect(props.neckPose.frames()).toEqual([[0, 0], [327, 1], [328, 0]])

    // A character who DIALED a physics morph (raw 0.3): the head holds that
    // value, not 0 — raw snapshot, raw key — so nothing walks the dial away
    // from what the character owns.
    const { utils: u2 } = loadUtils()
    const dialed = new FakeProp('dth_phy_breast_out_l', 0.3)
    const root2 = figure('Genesis9', [dialed])
    runPhysicsBlock(u2, root2, [dialed], 432)
    expect(dialed.frames().slice(0, 3)).toEqual([[0, 0.3], [431, 0.3], [432, 1]])
  })

  it('HEAD: a CONSTANT-held neighbour makes the plain write a no-op — the nudge still lands the key', () => {
    // The G9 base ROM zero-list keys ~700 channels CONSTANT at frames
    // 0/2/3/105. Had it stomped a physics channel, the value at 431 would
    // already equal the pre-block value, Daz's setValue would decline the
    // write, and the (0→432) jump would stay unfenced — hence the nudge.
    const { utils } = loadUtils()
    const stomped = new FakeProp('dth_phy_breast_out_l')
    for (const f of [0, 2, 3, 105]) stomped.keys.push({ t: f * TICKS, v: 0, interp: CONSTANT })
    const root = figure('Genesis9', [stomped])
    runPhysicsBlock(utils, root, [stomped], 432)
    expect(stomped.frames()).toContainEqual([431, 0])
    expect(stomped.at(431)).toBe(0)
    expect(stomped.at(432)).toBe(1)
  })

  it('PHY right after the base ROM (no GP): the base close-out keys at the block start, and the head anchor leaves those alone', () => {
    // Base 0–327 closed at 328, physics at 328. The neck pose and a pose whose
    // last spike sits a few frames before the close both reach frame 328
    // BEFORE the load — keys another pass made, not the block's. Without the
    // last-key rule the anchor would key their interpolated values at 327.
    const { utils } = loadUtils()
    const neck = new FakeProp('facs_bs_NeckUnderChin')
    neck.loadKey(327 * TICKS, 1)
    neck.loadKey(328 * TICKS, 0)
    const early = new FakeProp('facs_bs_JawOpen')
    early.loadKey(320 * TICKS, 1)
    early.loadKey(328 * TICKS, 0)
    const breastOut = new FakeProp('dth_phy_breast_out_l')
    const stomachHang = new FakeProp('dth_phy_stomach_hang')
    const props = [neck, early, breastOut, stomachHang]
    const root = figure('Genesis9', props)
    expect(runPhysicsBlock(utils, root, props, 328)).toBe(1)
    expect(neck.frames()).toEqual([[0, 0], [327, 1], [328, 0]])
    expect(early.frames()).toEqual([[0, 0], [320, 1], [328, 0]])
    expect(breastOut.frames().slice(0, 3)).toEqual([[0, 0], [327, 0], [328, 1]])
    expect(stomachHang.frames()).toEqual([[0, 0], [328, 0], [369, 0], [370, 1], [371, 0]])
  })

  it('HEAD: a head key that cannot be made is a run-log ERROR, never silence', () => {
    const { utils } = loadUtils()
    const stuck = new FakeProp('dth_phy_breast_out_l')
    const root = figure('Genesis9', [stuck])
    const pre = utils.memorizeRawMorphsAtFrame([root], 431)
    loadPhysicsPreset([stuck], 432)
    stuck.refuses = true
    expect(utils.anchorBlockHeadKeys([root], 432, pre)).toBe(0)
    expect(utils.runLog().errors).toHaveLength(1)
    expect(utils.runLog().errors[0]).toContain('dth_phy_breast_out_l label at frame 431')
  })

  it('a block at frame 0 has no head frame; the pre-block snapshot is RAW at that frame', () => {
    const { utils } = loadUtils()
    const { props, root } = g9Root()
    expect(utils.anchorBlockHeadKeys([root], 0, { raw: true, values: {} })).toBe(0)
    // Raw keeps the ERC share out: the cancelled dial reads -1, the driven one 0.
    const pre = utils.memorizeRawMorphsAtFrame([root], 431)
    expect(pre.raw).toBe(true)
    expect(pre.values.MB_Quella_Body_bs_body).toBe(-1)
    expect(pre.values.CJ_Head_bs_Head).toBe(0)
    expect(pre.values.ProportionHeight).toBe(0.5)
    expect(pre.values.facs_bs_NeckUnderChin).toBe(0)
    void props
  })
})
