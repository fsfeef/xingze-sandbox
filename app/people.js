// people.js — F 路：程序化行人（原创通用角色，全程序化，不用 Mixamo）
// 方案 §3.13 / 验收表第 14 行。游戏画面风格 · 星泽市。
// 做法：three-procedural-locomotion 的思路（逐帧由速度/朝向算步态：摆臂、迈腿、
// 身体起伏），但不用它的库——仓库里没有骨骼模型可供驱动，行人是程序化拼装体，
// 步态直接写在每帧的矩阵里。Mixamo 资产未用：仓库内无任何 FBX 资产，Mixamo
// 下载需账号登录，无法在 headless 环境核实许可；全程序化即零许可风险。
// 性能：全身 14 个 InstancedMesh（躯干/头/短发/长发/左腿/右腿/左臂/右臂/眼睛
// + 霓虹胸条 + 眉/口/帽/背包 = 14 个 draw call），64 个行人（48 人原拨 + 16 人街头生活拨）
// 每人种子不同，体型（肩/髋/腹/躯干长/腿长/臂粗）+ 衣服（tee/jacket/coat、帽、背包）
// + 步态（heavy/athletic/tired/normal）全按种子变，验重 0 重复，绝无 5 个一模一样的行人排一列。
// 第二拨道具另 3 个 draw call（狗/菜篮/手机各 1 个 InstancedMesh）。
// 绝不是胶囊人：头（球）+ 头发 + 眉眼口 + 躯干（上衣）+ 双臂 + 双腿 + 鞋，近看有人样。
// 玩家模型另见本文件 createPlayerModel（英雄人物：骨架 + 两骨 IK + Ara 脸）。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- 种子随机（确定性：同一行人每次加载同一个样子） ----------
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- 街道（人行道）-----------
// 地名按 data/six-names.json 虚构名。S1 星泽广场→星熙路，S2 星熙路→星光里，
// S3 纵穿星熙路，S4 横穿星泽广场，S5 纵穿星光里；X1/X2 是路口斑马线横穿段。
export const STREET_SEGMENTS = [
  { id: 'S1', a: [-114.9, -570.4], b: [1155.7, -994.9], weight: 14 },
  { id: 'S2', a: [1155.7, -994.9], b: [1390.3, -963.9], weight: 6 },
  { id: 'S3', a: [1155.7, -1400], b: [1155.7, -600], weight: 10 },
  { id: 'S4', a: [-500, -570.4], b: [300, -570.4], weight: 6 },
  { id: 'S5', a: [1390.3, -1200], b: [1390.3, -700], weight: 6 },
  { id: 'X1', a: [500, -790], b: [500, -762], weight: 3 },   // 斑马线：横穿 S1
  { id: 'X2', a: [1141, -994.9], b: [1170, -994.9], weight: 3 }, // 斑马线：横穿 S3
];

const SKINS = [0xE8B98F, 0xD9A06B, 0xC98A5A, 0xF0C8A0, 0xB97A4E];
const JACKETS = [0x1B2340, 0x274B63, 0x8B2E5E, 0xC75B12, 0x3A3F4A, 0x5B2E8B, 0x1F6B4A, 0xA83232, 0x2A3358, 0x0F766E, 0x7A1F3D, 0x334155];
const PANTS = [0x1E293B, 0x334155, 0x3F3F46, 0x1B2340, 0x44403C, 0x292524];
const HAIRS = [0x14100C, 0x3B2314, 0x6B4423, 0x9A9A9A, 0x00F0FF, 0xFF2E88]; // 最后两色是游戏画面风格染发，少数
const NEON = [0xFF2E88, 0x00F0FF, 0x8B5CFF, 0xFF9F1C];

// ---------- 玩家模型：Ara 脸 + 程序化骨架（3 路本轮重点） ----------
// 技能—方法（先技能、后阿哲的方法；对照表 S05/S07、F 路 player.js 待做项）：
//   threejs-to-3d-model：Three.js 代码程序化生成带骨骼动画的模型——
//     面朝 +Z、+Y 向上、单位米、四肢沿骨骼局部 -Y；一切运动是 u∈[0,1] 的
//     纯函数；IK 只写在 afterPose 里。本文件 createPlayerModel 就是这套：
//     骨架模板（hips→spine→chest→neck→head；肩→肘→手；髋→膝→踝），
//     姿态函数 setPose，IK 在 setPose 之后解（afterPose），GLB 导出走
//     BLENDER_PLAYER_SCRIPT（Blender 转 GLB/FBX + 烘焙，见下）。
//     注意：本机无 Blender、无 Chrome 导出环境，GLB 导出在八核实例上跑，
//     本地只做 node 逻辑验算；没跑过的步骤不说已完成。
//   blender-game-models：低模预算——玩家全身 ≤2 万三角面（胶囊/球/盒拼装，
//     贴图不进包，顶点色 + 程序化 canvas 仪表盘）；减面用 Decimate 思路
//     （BLENDER_PLAYER_SCRIPT 里 Collapse Ratio 0.6，关节处不减太狠）；
//     导出只留变形骨、去 IK 控制器、+Y Up。
//   3d-gen（Ara）：34 个面部 blend shape（20 表情 + 14 viseme），
//     名字原样照抄技能（ARKit/Oculus 名），不用 MakeHuman 底模（禁区）。
//     9 种表情 neutral/happy/laughing/angry/sad/crying/surprised/afraid/
//     determined；viseme 按 Rhubarb 映射（A→PP、B→kk、C→E、D→aa、E→O、
//     F→U、G→FF、H→nn、X→rest）。
//   three-procedural-locomotion：步态逐帧由速度/朝向算；两骨 IK 腿；
//     头/胸预判转向；tired/sneaky/athletic/heavy 预设（行人步态用）。
//   threejs-animation：AnimationMixer + AnimationClip + 权重混合；
//     程序化骨骼控制在 mixer.update() 之后写（本文件 update() 即此顺序）。
//   threejs-fbx-mixamo：动作槽位表用 Mixamo 内部 clip 名（Idle/Walking/
//     Running/Jumping Up/Landing）；Hips 位置轨不进 clip（位移归控制器）；
//     无 FBX 资产可载——仓库内无 FBX、Mixamo 下载要账号且许可无法在
//     headless 核实，所以槽位由程序化 clip/IK 驱动，不冒充 Mixamo clip。
//   procedural-gen：种子随机——每行人一个主种子，体型/衣服/步态各派生
//     子流（加一项不重排其他项）；加权表选衣服/发型；64 人逐项验重。
// 阿哲的方法（extract-from-formulasearch §1）：数据层（种子参数）→
//   逐处重建（玩家 1 人精建 + 64 行人逐项参数化）→ 两套构件库
//   （人物构件库：头/脸/肢/衣；街面构件库：见 street.js）→
//   像素回归（本轮：node 桩 THREE 验算手/脚落点 + 验重，见报告；
//   浏览器截图验由协调员 tests/verify-surpass-f.js 跑）→ 独立审查再合并
//   （改完只交文件，由总协调统一推，不自己推）。

// Ara 34 形状（3d-gen 技能原名）：20 表情 + 14 viseme。
export const FACE_SHAPES = [
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeWideLeft', 'eyeWideRight',
  'eyeSquintLeft', 'eyeSquintRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'jawOpen', 'mouthSmile', 'mouthFrown', 'mouthPucker', 'mouthPress',
  'mouthStretch', 'mouthUpperUp', 'noseSneerLeft', 'noseSneerRight',
  'viseme_PP', 'viseme_FF', 'viseme_TH', 'viseme_DD', 'viseme_kk', 'viseme_CH',
  'viseme_SS', 'viseme_nn', 'viseme_RR', 'viseme_aa', 'viseme_E', 'viseme_I',
  'viseme_O', 'viseme_U',
];
// Ara 9 种表情（权重 0..1）。
export const EXPRESSIONS = {
  neutral: {},
  happy: { mouthSmile: 0.8, eyeSquintLeft: 0.3, eyeSquintRight: 0.3, browOuterUpLeft: 0.2, browOuterUpRight: 0.2 },
  laughing: { mouthSmile: 1, jawOpen: 0.45, eyeSquintLeft: 0.6, eyeSquintRight: 0.6 },
  angry: { browDownLeft: 0.9, browDownRight: 0.9, mouthPress: 0.6, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  sad: { browInnerUp: 0.8, mouthFrown: 0.7, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
  crying: { browInnerUp: 1, mouthFrown: 0.9, jawOpen: 0.25, eyeSquintLeft: 0.5, eyeSquintRight: 0.5 },
  surprised: { eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 0.7, browOuterUpLeft: 0.7, browOuterUpRight: 0.7, jawOpen: 0.5 },
  afraid: { eyeWideLeft: 0.9, eyeWideRight: 0.9, browInnerUp: 0.8, mouthStretch: 0.5 },
  determined: { browDownLeft: 0.5, browDownRight: 0.5, mouthPress: 0.8, eyeSquintLeft: 0.2, eyeSquintRight: 0.2 },
};
// viseme → 形状权重（Rhubarb 映射：A→PP、B→kk、C→E、D→aa、E→O、F→U、G→FF、H→nn、X→rest）。
export const VISEME_SHAPES = {
  viseme_PP: { mouthPress: 1 },
  viseme_FF: { jawOpen: 0.1, mouthUpperUp: 0.7 },
  viseme_TH: { jawOpen: 0.2, mouthStretch: 0.3 },
  viseme_DD: { jawOpen: 0.25 },
  viseme_kk: { jawOpen: 0.2 },
  viseme_CH: { jawOpen: 0.3, mouthPucker: 0.3 },
  viseme_SS: { jawOpen: 0.15, mouthStretch: 0.4 },
  viseme_nn: { jawOpen: 0.2 },
  viseme_RR: { jawOpen: 0.3, mouthPucker: 0.2 },
  viseme_aa: { jawOpen: 0.7, mouthStretch: 0.2 },
  viseme_E: { jawOpen: 0.3, mouthStretch: 0.5 },
  viseme_I: { jawOpen: 0.15, mouthStretch: 0.7 },
  viseme_O: { jawOpen: 0.45, mouthPucker: 0.6 },
  viseme_U: { jawOpen: 0.25, mouthPucker: 0.8 },
};
export const RHUBARB_TO_VISEME = { A: 'viseme_PP', B: 'viseme_kk', C: 'viseme_E', D: 'viseme_aa', E: 'viseme_O', F: 'viseme_U', G: 'viseme_FF', H: 'viseme_nn', X: null };

// 玩家默认规格（1.75m 成人；肩/髋/腹为系数，1.0 = 标准）。
export const PLAYER_SPEC = {
  height: 1.75, shoulder: 1.0, hip: 1.0, belly: 1.0,
  skin: 0xE8B98F, hair: 0x14100C, hairStyle: 'short',
  top: 0x274B63, topStyle: 'jacket', pants: 0x1E293B, shoes: 0x1F2937,
};
// 驾驶坐姿标定值（playercar.js 共用，单点来源；数值已验算）：
//   臀点 (0.38, 0.80, 0.02)；方向盘中心 (0.38, 1.24, 0.42)，握点 10 点/2 点；
//   肩→握 0.585m（臂长 0.62）；右脚→油门 0.638m、左脚→歇脚板 0.605m（腿长 0.84）；
//   头顶 1.671m，内顶 1.68m（余量 9mm，躯干后仰 6°）。
//   注意：旧座椅 0.92m + 旧车顶 1.50m 时头顶 1.895m 会顶穿车顶，所以本轮
//   座椅降到 0.68m、车顶抬到 1.72m（playercar.js 同改），不是只改人。
export const DRIVE_POSE = {
  seat: [0.38, 0.80, 0.02], lean: 0.10,
  handL: [0.21, 1.34, 0.42], handR: [0.55, 1.34, 0.42],
  footL: [0.48, 0.46, 0.52], footR: [0.22, 0.50, 0.58],
};

// ---------- Blender 生成脚本（重活，大跑） ----------
// 做法（BeyondTheBoxCN 思路：AI 写 Python 脚本 + Blender 程序化建模，
// MCP for Blender 那套；不用 MPFB、不用 MakeHuman——禁区）。
// 跑法（八核实例 /mnt/workspace/xingze-sandbox，实例空转超 1 小时自动关，
// 上去连续做，别晾着）：
//   blender --background --python player_gen.py -- \
//     --seed 1 --height 1.75 --shoulder 1.0 --hip 1.0 --belly 1.0 \
//     --hair short --out /mnt/workspace/xingze-sandbox/out/player.glb
// 本地小机器只跑：python3 -m py_compile player_gen.py（不跑 Blender）。
// 脚本与本文件 createPlayerModel 同参数（height/shoulder/hip/belly/hair），
// 同骨架名（hips/spine/neck/head/shoulder_L/R、elbow、hand、hip、knee、ankle），
// 导出只留变形骨、去 IK 控制器、+Y Up；三角面预算 ≤20000。
export const BLENDER_PLAYER_SCRIPT = `import argparse
import math
import sys

import bpy


def clear_scene():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete(use_global=False)
    for block in bpy.data.meshes:
        bpy.data.meshes.remove(block)


def add_box(name, loc, scale, mat=None):
    bpy.ops.mesh.primitive_cube_add(location=loc)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def add_sphere(name, loc, radius, mat=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=radius, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def add_cylinder(name, loc, radius, depth, mat=None):
    bpy.ops.mesh.primitive_cylinder_add(radius=radius, depth=depth, location=loc)
    obj = bpy.context.active_object
    obj.name = name
    if mat is not None:
        obj.data.materials.append(mat)
    return obj


def make_material(name, rgb):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (rgb[0], rgb[1], rgb[2], 1.0)
    bsdf.inputs['Roughness'].default_value = 0.8
    return mat


def build_player(args):
    k = args.height / 1.75
    hip_y = 0.88 * k
    skin = make_material('Skin', (0.91, 0.72, 0.56))
    cloth = make_material('Top', (0.15, 0.29, 0.39))
    pants = make_material('Pants', (0.12, 0.16, 0.23))
    hair_m = make_material('Hair', (0.08, 0.06, 0.05))
    parts = []
    parts.append(add_sphere('Head', (0, hip_y + 0.74 * k, 0), 0.115 * k, skin))
    parts.append(add_sphere('HairCap', (0, hip_y + 0.76 * k, -0.01), 0.122 * k, hair_m))
    parts.append(add_cylinder('Torso', (0, hip_y + 0.26 * k, 0), 0.19 * k, 0.52 * k, cloth))
    parts.append(add_sphere('Hips', (0, hip_y, 0), 0.16 * k, pants))
    for sx in (-1, 1):
        parts.append(add_cylinder('UpperArm', (sx * 0.20, hip_y + 0.30 * k, 0), 0.05 * k, 0.32 * k, skin))
        parts.append(add_cylinder('Forearm', (sx * 0.20, hip_y - 0.02 * k, 0), 0.042 * k, 0.30 * k, skin))
        parts.append(add_cylinder('Thigh', (sx * 0.10, hip_y - 0.21 * k, 0), 0.07 * k, 0.42 * k, pants))
        parts.append(add_cylinder('Shin', (sx * 0.10, hip_y - 0.63 * k, 0), 0.055 * k, 0.42 * k, pants))
        parts.append(add_box('Shoe', (sx * 0.10, 0.035 * k, 0.05), (0.05 * k, 0.035 * k, 0.13 * k), pants))
    return parts


def add_bone(arm, name, head, tail, parent=None):
    bone = arm.data.edit_bones.new(name)
    bone.head = head
    bone.tail = tail
    if parent is not None:
        bone.parent = parent
    return bone


def build_rig(args):
    k = args.height / 1.75
    hip_y = 0.88 * k
    bpy.ops.object.armature_add(enter_editmode=False, location=(0, hip_y, 0))
    arm = bpy.context.active_object
    arm.name = 'PlayerRig'
    bpy.ops.object.mode_set(mode='EDIT')
    hips = add_bone(arm, 'hips', (0, 0, 0), (0, 0.15, 0))
    spine = add_bone(arm, 'spine', (0, 0.10 * k, 0), (0, 0.52 * k, 0), hips)
    neck = add_bone(arm, 'neck', (0, 0.52 * k, 0), (0, 0.62 * k, 0), spine)
    head = add_bone(arm, 'head', (0, 0.62 * k, 0), (0, 0.78 * k, 0), neck)
    for side, sx in (('L', 1), ('R', -1)):
        shoulder = add_bone(arm, 'shoulder_' + side, (sx * 0.20, 0.46 * k, 0), (sx * 0.26, 0.46 * k, 0), spine)
        elbow = add_bone(arm, 'elbow_' + side, (sx * 0.20, 0.14 * k, 0), (sx * 0.20, 0.02 * k, 0), shoulder)
        add_bone(arm, 'hand_' + side, (sx * 0.20, -0.16 * k, 0), (sx * 0.20, -0.24 * k, 0), elbow)
        hip = add_bone(arm, 'hip_' + side, (sx * 0.10, 0, 0), (sx * 0.10, -0.15 * k, 0), hips)
        knee = add_bone(arm, 'knee_' + side, (sx * 0.10, -0.42 * k, 0), (sx * 0.10, -0.54 * k, 0), hip)
        add_bone(arm, 'ankle_' + side, (sx * 0.10, -0.84 * k, 0), (sx * 0.10, -0.88 * k, 0), knee)
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--height', type=float, default=1.75)
    parser.add_argument('--shoulder', type=float, default=1.0)
    parser.add_argument('--hip', type=float, default=1.0)
    parser.add_argument('--belly', type=float, default=1.0)
    parser.add_argument('--hair', default='short')
    parser.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    clear_scene()
    parts = build_player(args)
    arm = build_rig(args)
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    for obj in parts:
        mod = obj.modifiers.new('Decimate', 'DECIMATE')
        mod.decimate_type = 'COLLAPSE'
        mod.ratio = 0.6
    bpy.ops.object.select_all(action='DESELECT')
    for obj in parts:
        obj.select_set(True)
    bpy.ops.export_scene.gltf(filepath=args.out, export_format='GLB', export_apply=True)
    print('EXPORTED', args.out)


if __name__ == '__main__':
    main(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
`;
export const BLENDER_RUN_CMD = 'blender --background --python player_gen.py -- --seed 1 --height 1.75 --shoulder 1.0 --hip 1.0 --belly 1.0 --hair short --out /mnt/workspace/xingze-sandbox/out/player.glb';

const COUNT = 48;
const LIFE_COUNT = 16; // 第二拨：街头生活行人（遛狗 4 / 买菜 4 / 等车 4 / 看手机 4）
const TOTAL = COUNT + LIFE_COUNT; // 64：48 人原样不动，后面追加 16 人

let ctx = null;
let group = null;
let parts = null;      // { torso, head, hairCap, hairLong, legL, legR, armL, armR, eyes, accent }
let props = null;      // 第二拨道具 { dog, bag, phone }（各一个 InstancedMesh）
let propOrigColors = null; // 白膜恢复用：道具每实例的原色
let pedestrians = [];
let rafId = 0;
let lastT = 0;
let displayMode = 'normal';
let origColors = null; // white 模式恢复用：每部件每实例的原色

function groundY(x, z) {
  try {
    if (ctx && ctx.sixLoader && ctx.sixLoader.groundHeightAt) return ctx.sixLoader.groundHeightAt(x, z);
  } catch (e) { /* fall through */ }
  return 3.0;
}

function segPoint(seg, t, side) {
  const dx = seg.b[0] - seg.a[0], dz = seg.b[1] - seg.a[1];
  const len = Math.hypot(dx, dz);
  const nx = -dz / len, nz = dx / len; // 法向（人行道偏移方向）
  const x = seg.a[0] + dx * t + nx * side;
  const z = seg.a[1] + dz * t + nz * side;
  return { x, z, heading: Math.atan2(dx, dz) };
}

// ---------- 行人体型/衣服参数（procedural-gen：派生子流 + 加权表） ----------
// 旧字段照原顺序抽（48 人原样不动）；新字段走派生子流——加一项不重排旧流。
// 加权表（procedural-gen Pattern 3）：上衣 tee 3 / jacket 5 / coat 2。
const HATS = [0x1B2340, 0x8B2E5E, 0xC75B12, 0x1F6B4A, 0x334155, 0xA83232];
const PACKS = [0x1B2340, 0x8B2E5E, 0xC75B12, 0x274B63, 0x3A3F4A];
const MOUTHS = [0x8A4A3A, 0x9C5A48, 0x7A3A30, 0xB06A55];
function weightedPick(rnd, table) {
  let total = 0;
  for (const [, w] of table) total += w;
  let r = rnd() * total;
  for (const [v, w] of table) { r -= w; if (r <= 0) return v; }
  return table[table.length - 1][0];
}
// 步态预设（three-procedural-locomotion：tired/athletic/heavy；sneaky 不用于街面）。
const GAIT_PRESETS = {
  heavy: { rate: 0.85, bob: 1.5, arm: 0.7, stride: 0.9, lean: 0.10 },
  athletic: { rate: 1.1, bob: 0.8, arm: 1.2, stride: 1.15, lean: 0.04 },
  tired: { rate: 0.8, bob: 1.2, arm: 0.6, stride: 0.85, lean: 0.12 },
  normal: { rate: 1, bob: 1, arm: 1, stride: 1, lean: 0.06 },
};
export function pedestrianBodyParams(idx) {
  const seed = (Math.imul(idx + 1, 2654435761) >>> 0);
  const rB = mulberry32((0xB0D7 ^ seed) >>> 0);
  const rC = mulberry32((0xC107 ^ Math.imul(idx + 1, 40503)) >>> 0);
  const rG = mulberry32((0x6A17 ^ Math.imul(idx + 1, 2246822519)) >>> 0);
  const p = {
    shoulder: 0.88 + rB() * 0.30,   // 肩宽 0.88–1.18
    hip: 0.88 + rB() * 0.28,        // 髋宽 0.88–1.16
    belly: 0.90 + rB() * 0.38,      // 腹围 0.90–1.28（>1.20 为 heavy）
    torsoLen: 0.92 + rB() * 0.22,   // 躯干长 0.92–1.14（coat 另加长）
    legLen: 0.94 + rB() * 0.12,     // 腿长 0.94–1.06
    armThick: 0.90 + rB() * 0.25,   // 臂粗 0.90–1.15
    top: weightedPick(rC, [['tee', 3], ['jacket', 5], ['coat', 2]]),
    hat: rC() < 0.25 ? 'cap' : 'none',
    hatColor: HATS[Math.floor(rC() * HATS.length)],
    pack: rC() < 0.20,
    packColor: PACKS[Math.floor(rC() * PACKS.length)],
    mouthColor: MOUTHS[Math.floor(rC() * MOUTHS.length)],
    browTilt: (rG() - 0.5) * 0.5,   // 眉形：-0.25..0.25（怒/愁各异）
  };
  if (p.belly > 1.20) p.gait = 'heavy';
  else if (p.shoulder > 1.10 && p.belly < 1.05) p.gait = 'athletic';
  else if (rG() < 0.15) p.gait = 'tired';
  else p.gait = 'normal';
  p.gaitM = GAIT_PRESETS[p.gait];
  if (p.top === 'coat') p.torsoLen = Math.min(1.30, p.torsoLen + 0.16); // 长外套盖髋
  if (p.top === 'tee') p.torsoLen = Math.max(0.88, p.torsoLen - 0.06);  // T 恤短一截
  return p;
}
// 验重（procedural-gen seed sweep 的行人版）：体型+衣服+发型全同才算重复。
export function validateCrowd(list) {
  const seen = new Map();
  let dup = 0;
  for (const p of list) {
    const key = [
      p.shoulder.toFixed(2), p.hip.toFixed(2), p.belly.toFixed(2),
      p.torsoLen.toFixed(2), p.legLen.toFixed(2), p.jacket, p.pants,
      p.hair, p.hairLong, p.top, p.hat, p.pack,
    ].join('|');
    if (seen.has(key)) dup++;
    else seen.set(key, 1);
  }
  return { total: list.length, unique: seen.size, duplicates: dup };
}

// ---------- 两骨 IK（three-procedural-locomotion 的腿/臂 IK 思路） ----------
// 关节组沿本地 -Y 伸肢（threejs-to-3d-model 硬性规则）。target 以 rootObj
// 的父空间坐标给；pole 是肘/膝弯向（手臂肘朝下偏后，腿膝朝前）。
const _ikDown = new THREE.Vector3(0, -1, 0);
const _ikT = new THREE.Vector3();
const _ikU = new THREE.Vector3();
const _ikP = new THREE.Vector3();
const _ikE = new THREE.Vector3();
const _ikTc = new THREE.Vector3();
const _ikE2 = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
export function solveTwoBone(rootObj, midObj, L1, L2, target, pole) {
  const S = rootObj.position;
  _ikT.copy(target).sub(S);
  let d = _ikT.length();
  d = Math.max(0.05, Math.min(d, L1 + L2 - 0.001));
  _ikU.copy(_ikT).normalize();
  _ikTc.copy(S).addScaledVector(_ikU, d); // 夹紧后的目标点
  _ikP.copy(pole).addScaledVector(_ikU, -pole.dot(_ikU));
  if (_ikP.lengthSq() < 1e-6) _ikP.set(0, 0, 1);
  _ikP.normalize();
  const cosA = Math.max(-1, Math.min(1, (L1 * L1 + d * d - L2 * L2) / (2 * L1 * d)));
  const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
  _ikE.copy(_ikU).multiplyScalar(cosA).addScaledVector(_ikP, sinA);
  rootObj.quaternion.setFromUnitVectors(_ikDown, _ikE);
  _ikE2.copy(_ikE).multiplyScalar(L1).add(S); // 肘位置 E（父空间）
  _ikTc.sub(_ikE2).normalize(); // _ikTc = 下段方向 e2（目标点已用完，可复用）
  _ikQ.copy(rootObj.quaternion).invert();
  _ikE2.copy(_ikTc).applyQuaternion(_ikQ); // e2 转到 rootObj 局部
  midObj.quaternion.setFromUnitVectors(_ikDown, _ikE2);
}

// 动作槽位表（threejs-fbx-mixamo：槽位名用 Mixamo 内部 clip 名；
// Hips 位置轨不进 clip——位移归控制器（app.js / 车），本文件只摆姿态。
// 无 FBX 可载：idle 是真 AnimationClip，其余由程序化 IK 驱动，不冒充 clip。）
export const ANIMATION_SLOTS = {
  idle: { clip: 'Idle', source: 'procedural-clip', mixamoName: 'Idle' },
  walk: { clip: 'Walking', source: 'procedural-ik', mixamoName: 'Walking' },
  run: { clip: 'Running', source: 'procedural-ik', mixamoName: 'Running' },
  jump: { clip: 'Jumping Up', source: 'procedural-ik', mixamoName: 'Jumping Up' },
  land: { clip: 'Landing', source: 'procedural-ik', mixamoName: 'Landing' },
};

// ---------- 玩家模型：程序化英雄人物（threejs-to-3d-model 做法） ----------
// 骨架：root(臀点原点) → spine → neck → head；肩 → 肘 → 手；髋 → 膝 → 踝。
// 面朝 +Z、+Y 向上、单位米、四肢沿骨骼局部 -Y。姿态是 u∈[0,1] 的纯函数，
// IK 只写在 setPose 之后（afterPose）。三角面预算 ≤20000（blender-game-models）。
// 脸：Ara 34 形状 + 9 表情 + 14 viseme（见文件头常量）；眨眼自动。
// 不是胶囊人：头（球 + 下巴 + 鼻 + 耳）+ 眉眼口 + 头发 + 躯干（胸/腰分段）
// + 双臂（肘/手掌/手指）+ 双腿（膝/鞋），近看有人样。
export function createPlayerModel(THREE, spec = {}) {
  const s = { ...PLAYER_SPEC, ...spec };
  const k = s.height / 1.75;
  const L = {
    thigh: 0.42 * k, shin: 0.42 * k, upper: 0.32 * k, fore: 0.30 * k,
    torso: 0.52 * k, hipY: 0.88 * k,
    shoulderW: 0.20 * s.shoulder, hipW: 0.10 * s.hip,
  };
  const mat = (color, roughness = 0.8) => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0.05 });
  const skinM = mat(s.skin, 0.65), topM = mat(s.top, 0.85), pantsM = mat(s.pants, 0.85);
  const shoeM = mat(s.shoes, 0.6), hairM = mat(s.hair, 0.9);
  const darkM = new THREE.MeshBasicMaterial({ color: 0x1A1210 });
  const teethM = new THREE.MeshStandardMaterial({ color: 0xF5F0E6, roughness: 0.4 });
  const tongueM = new THREE.MeshStandardMaterial({ color: 0xC25A6B, roughness: 0.7 });

  const root = new THREE.Group();
  root.name = 'player-root';
  const mesh = (geo, material, parent, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  const joint = (parent, name, x, y, z) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };
  const capsule = (r, len, material, parent, y) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 4, 10), material);
    m.position.y = y;
    parent.add(m);
    return m;
  };
  // 几何预变换（合批用：同材质静态件先合再挂，省 draw call）。
  const xg = (geo, x, y, z, sx = 1, sy = 1, sz = 1) => { geo.scale(sx, sy, sz); geo.translate(x, y, z); return geo; };

  // 躯干：胸（球压扁）+ 腰（圆柱）合批 + 骨盆（球压扁）；jacket 加拉链线。
  const spine = joint(root, 'spine', 0, 0.10 * k, 0);
  mesh(mergeGeometries([
    xg(new THREE.SphereGeometry(0.19 * k, 14, 10), 0, 0.22 * k, 0, s.shoulder, 1.15, 0.78 * s.belly),
    xg(new THREE.CylinderGeometry(0.15 * k * s.hip, 0.17 * k * s.hip, 0.22 * k, 12), 0, 0.02 * k, 0),
  ]), topM, spine, 0, 0, 0);
  const pelvis = mesh(new THREE.SphereGeometry(0.16 * k, 12, 8), pantsM, root, 0, -0.02 * k, 0);
  pelvis.scale.set(s.hip, 0.62, 0.82 * s.belly);
  if (s.topStyle === 'jacket') {
    mesh(new THREE.BoxGeometry(0.02, 0.34 * k, 0.012), mat(0x111111, 0.9), spine, 0, 0.22 * k, 0.155 * k * s.belly);
  }
  // 颈 + 头。
  const neck = joint(spine, 'neck', 0, 0.52 * k, 0);
  mesh(new THREE.CylinderGeometry(0.05 * k, 0.06 * k, 0.12 * k, 10), skinM, neck, 0, 0.02 * k, 0);
  const head = joint(neck, 'head', 0, 0.12 * k, 0);
  // 头颅/耳/鼻合批（静态件，同肤色）；鼻翼另留两件（noseSneer 要动）。
  mesh(mergeGeometries([
    xg(new THREE.SphereGeometry(0.115 * k, 18, 12), 0, 0, 0, 1, 1.12, 0.98),
    xg(new THREE.SphereGeometry(0.02 * k, 8, 6), -0.115 * k, 0, 0),
    xg(new THREE.SphereGeometry(0.02 * k, 8, 6), 0.115 * k, 0, 0),
    xg(new THREE.BoxGeometry(0.022 * k, 0.04 * k, 0.025 * k), 0, -0.015 * k, 0.108 * k),
  ]), skinM, head, 0, 0, 0);
  // 眼：白 + 瞳 + 上眼睑（眨眼/瞪眼/眯眼都走眼睑）。
  const mkEye = (sx) => {
    const g = joint(head, sx > 0 ? 'eyeL' : 'eyeR', sx * 0.042 * k, 0.012 * k, 0.10 * k);
    const white = mesh(new THREE.SphereGeometry(0.017 * k, 10, 8), new THREE.MeshStandardMaterial({ color: 0xF5F2EA, roughness: 0.3 }), g, 0, 0, 0);
    white.scale.set(1, 1, 0.6);
    mesh(new THREE.SphereGeometry(0.008 * k, 8, 6), darkM, g, 0, 0, 0.010 * k);
    const lid = mesh(new THREE.BoxGeometry(0.038 * k, 0.014 * k, 0.012 * k), skinM, g, 0, 0.012 * k, 0.004 * k);
    return { g, lid };
  };
  const eyeL = mkEye(1), eyeR = mkEye(-1);
  // 眉（Ara browDown/browInnerUp/browOuterUp 都走这两块）。
  const browL = mesh(new THREE.BoxGeometry(0.05 * k, 0.012 * k, 0.014 * k), hairM, head, 0.042 * k, 0.048 * k, 0.102 * k);
  const browR = mesh(new THREE.BoxGeometry(0.05 * k, 0.012 * k, 0.014 * k), hairM, head, -0.042 * k, 0.048 * k, 0.102 * k);
  // 口：上唇 + 暗腔 + 上齿 + 下颌组（下唇/下齿/舌头/下巴，随 jawOpen 转）。
  const mouth = joint(head, 'mouth', 0, -0.058 * k, 0.098 * k);
  const upperLip = mesh(new THREE.BoxGeometry(0.052 * k, 0.009 * k, 0.012 * k), mat(0x8A4A3A, 0.7), mouth, 0, 0.006 * k, 0);
  const mouthDark = mesh(new THREE.BoxGeometry(0.046 * k, 0.018 * k, 0.006 * k), darkM, mouth, 0, -0.004 * k, -0.002 * k);
  mesh(new THREE.BoxGeometry(0.042 * k, 0.010 * k, 0.006 * k), teethM, mouth, 0, 0.002 * k, 0.002 * k);
  const jaw = joint(head, 'jaw', 0, -0.03 * k, 0.03 * k);
  const lowerLip = mesh(new THREE.BoxGeometry(0.05 * k, 0.008 * k, 0.012 * k), mat(0x8A4A3A, 0.7), jaw, 0, -0.028 * k, 0.068 * k);
  mesh(new THREE.BoxGeometry(0.04 * k, 0.008 * k, 0.006 * k), teethM, jaw, 0, -0.024 * k, 0.068 * k);
  mesh(new THREE.BoxGeometry(0.03 * k, 0.012 * k, 0.02 * k), tongueM, jaw, 0, -0.03 * k, 0.055 * k);
  const chin = mesh(new THREE.SphereGeometry(0.07 * k, 10, 8), skinM, jaw, 0, -0.045 * k, -0.01 * k);
  chin.scale.set(1.1, 0.7, 0.9);
  const cornerL = mesh(new THREE.BoxGeometry(0.012 * k, 0.012 * k, 0.01 * k), mat(0x8A4A3A, 0.7), mouth, 0.028 * k, 0, 0);
  const cornerR = mesh(new THREE.BoxGeometry(0.012 * k, 0.012 * k, 0.01 * k), mat(0x8A4A3A, 0.7), mouth, -0.028 * k, 0, 0);
  // 鼻翼（noseSneer）。
  const wingL = mesh(new THREE.BoxGeometry(0.012 * k, 0.014 * k, 0.01 * k), skinM, head, 0.018 * k, -0.025 * k, 0.105 * k);
  const wingR = mesh(new THREE.BoxGeometry(0.012 * k, 0.014 * k, 0.01 * k), skinM, head, -0.018 * k, -0.025 * k, 0.105 * k);
  // 头发：发盖 + 发型件合批（short/long/bun/cap）。
  const hairParts = [xg(new THREE.SphereGeometry(0.122 * k, 14, 8, 0, Math.PI * 2, 0, 1.35), 0, 0.012 * k, -0.005 * k, 1, 1.05, 1.02)];
  if (s.hairStyle === 'long') hairParts.push(xg(new THREE.BoxGeometry(0.24 * k, 0.30 * k, 0.06 * k), 0, -0.06 * k, -0.09 * k));
  else if (s.hairStyle === 'bun') hairParts.push(xg(new THREE.SphereGeometry(0.05 * k, 10, 8), 0, 0.10 * k, -0.10 * k));
  else if (s.hairStyle === 'cap') hairParts.push(xg(new THREE.BoxGeometry(0.16 * k, 0.015 * k, 0.10 * k), 0, 0.02 * k, 0.16 * k));
  mesh(mergeGeometries(hairParts), hairM, head, 0, 0, 0);

  // 四肢：上臂/前臂/手（掌 + 指 + 拇指），大腿/小腿/鞋。
  const mkArm = (sx) => {
    const shoulder = joint(root, sx > 0 ? 'shoulderL' : 'shoulderR', sx * L.shoulderW, 0.46 * k, 0);
    capsule(0.05 * k, L.upper - 0.08 * k, skinM, shoulder, -L.upper / 2);
    const elbow = joint(shoulder, sx > 0 ? 'elbowL' : 'elbowR', 0, -L.upper, 0);
    capsule(0.042 * k, L.fore - 0.07 * k, skinM, elbow, -L.fore / 2);
    const hand = joint(elbow, sx > 0 ? 'handL' : 'handR', 0, -L.fore, 0);
    // 手：掌 + 指 + 拇指合批（不同指不动，合一件）。
    mesh(mergeGeometries([
      xg(new THREE.BoxGeometry(0.07 * k, 0.10 * k, 0.03 * k), 0, -0.05 * k, 0),
      xg(new THREE.BoxGeometry(0.06 * k, 0.05 * k, 0.025 * k), 0, -0.12 * k, 0),
      xg(new THREE.BoxGeometry(0.02 * k, 0.04 * k, 0.02 * k), sx * 0.04 * k, -0.06 * k, 0.01 * k),
    ]), skinM, hand, 0, 0, 0);
    return { shoulder, elbow, hand };
  };
  const mkLeg = (sx) => {
    const hipJ = joint(root, sx > 0 ? 'hipL' : 'hipR', sx * L.hipW, -0.02 * k, 0);
    capsule(0.07 * k, L.thigh - 0.10 * k, pantsM, hipJ, -L.thigh / 2);
    const knee = joint(hipJ, sx > 0 ? 'kneeL' : 'kneeR', 0, -L.thigh, 0);
    capsule(0.055 * k, L.shin - 0.08 * k, pantsM, knee, -L.shin / 2);
    const ankle = joint(knee, sx > 0 ? 'ankleL' : 'ankleR', 0, -L.shin, 0);
    mesh(new THREE.BoxGeometry(0.10 * k, 0.07 * k, 0.26 * k), shoeM, ankle, 0, -0.035 * k, 0.06 * k);
    return { hipJ, knee, ankle };
  };
  const armL = mkArm(1), armR = mkArm(-1);
  const legL = mkLeg(1), legR = mkLeg(-1);

  // ---- 脸权重（Ara 34 形状） ----
  const face = {};
  for (const n of FACE_SHAPES) face[n] = 0;
  const faceTarget = { ...face };
  const exprTarget = { ...face };
  const visTarget = { ...face };
  let expression = 'neutral';
  let viseme = null;
  function setExpression(name, w = 1) {
    if (!EXPRESSIONS[name]) return false;
    expression = name;
    for (const n of FACE_SHAPES) exprTarget[n] = (EXPRESSIONS[name][n] || 0) * w;
    return true;
  }
  function setViseme(name, w = 1) {
    if (name === null) { viseme = null; for (const n of FACE_SHAPES) visTarget[n] = 0; return true; }
    const shapes = VISEME_SHAPES[name];
    if (!shapes) return false;
    viseme = name;
    for (const n of FACE_SHAPES) visTarget[n] = (shapes[n] || 0) * w;
    return true;
  }
  function setRhubarbCue(cue, w = 1) {
    const v = RHUBARB_TO_VISEME[cue];
    return v ? setViseme(v, w) : setViseme(null);
  }
  const _v3a = new THREE.Vector3();
  function applyFace() {
    for (const n of FACE_SHAPES) face[n] = Math.max(0, Math.min(1, exprTarget[n] + visTarget[n]));
    const blinkL = Math.max(face.eyeBlinkLeft, _blink), blinkR = Math.max(face.eyeBlinkRight, _blink);
    eyeL.lid.position.y = (0.012 + 0.006 * face.eyeWideLeft - 0.008 * face.eyeSquintLeft - 0.016 * blinkL) * k;
    eyeR.lid.position.y = (0.012 + 0.006 * face.eyeWideRight - 0.008 * face.eyeSquintRight - 0.016 * blinkR) * k;
    browL.rotation.z = (0.35 * face.browDownLeft + 0.30 * face.browOuterUpLeft) * 1;
    browR.rotation.z = -(0.35 * face.browDownRight + 0.30 * face.browOuterUpRight);
    browL.position.y = (0.048 + 0.012 * face.browInnerUp) * k;
    browR.position.y = (0.048 + 0.012 * face.browInnerUp) * k;
    jaw.rotation.x = 0.38 * face.jawOpen;
    jaw.position.y = (-0.03 - 0.01 * face.jawOpen) * k;
    mouthDark.scale.y = 0.3 + 0.9 * face.jawOpen;
    mouthDark.scale.x = 1 + 0.35 * face.mouthStretch - 0.4 * face.mouthPucker;
    upperLip.scale.x = 1 + 0.35 * face.mouthStretch - 0.4 * face.mouthPucker;
    upperLip.scale.y = 1 - 0.6 * face.mouthPress;
    upperLip.position.y = (0.006 + 0.008 * face.mouthUpperUp) * k;
    lowerLip.scale.x = upperLip.scale.x;
    lowerLip.scale.y = 1 - 0.6 * face.mouthPress;
    cornerL.position.y = (0.008 * face.mouthSmile - 0.008 * face.mouthFrown) * k;
    cornerR.position.y = (0.008 * face.mouthSmile - 0.008 * face.mouthFrown) * k;
    cornerL.position.x = (0.028 - 0.004 * face.mouthSmile) * k;
    cornerR.position.x = -(0.028 - 0.004 * face.mouthSmile) * k;
    wingL.position.y = (-0.025 + 0.005 * face.noseSneerLeft) * k;
    wingR.position.y = (-0.025 + 0.005 * face.noseSneerRight) * k;
  }

  // ---- 呼吸 clip（threejs-animation：真 AnimationClip + Mixer） ----
  const mixer = new THREE.AnimationMixer(root);
  const idleClip = new THREE.AnimationClip('Idle', 4, [
    new THREE.NumberKeyframeTrack('spine.position[y]', [0, 2, 4], [0.10 * k, 0.112 * k, 0.10 * k]),
    new THREE.NumberKeyframeTrack('head.rotation[y]', [0, 2, 4], [0, 0.05, 0]),
  ]);
  const idleAction = mixer.clipAction(idleClip);
  idleAction.play();

  // ---- 姿态（IK 在 setPose 之后解 = afterPose；位移归控制器，不碰 root 位置） ----
  let lean = 0;
  let mode = 'stand';
  let walkSpeed = 0;
  let walkPhase = 0;
  const _tgt = new THREE.Vector3();
  const _poleArm = new THREE.Vector3(0, -0.5, -1);
  const _poleLeg = new THREE.Vector3(0, 0.3, 1);
  function toLocal(arr) {
    // 父空间坐标 → root 局部（root 只绕 X 转 -lean 角 + 平移；逆变换是 RotX(+lean)）。
    _tgt.set(arr[0], arr[1], arr[2]).sub(root.position);
    const c = Math.cos(lean), s = Math.sin(lean);
    const y = _tgt.y * c - _tgt.z * s;
    const z = _tgt.y * s + _tgt.z * c;
    _tgt.y = y; _tgt.z = z;
    return _tgt;
  }
  function poseLimbs(handL, handR, footL, footR) {
    solveTwoBone(armL.shoulder, armL.elbow, L.upper, L.fore, handL, _poleArm);
    solveTwoBone(armR.shoulder, armR.elbow, L.upper, L.fore, handR, _poleArm);
    solveTwoBone(legL.hipJ, legL.knee, L.thigh, L.shin, footL, _poleLeg);
    solveTwoBone(legR.hipJ, legR.knee, L.thigh, L.shin, footR, _poleLeg);
  }
  const _vHandL = new THREE.Vector3(), _vHandR = new THREE.Vector3();
  const _vFootL = new THREE.Vector3(), _vFootR = new THREE.Vector3();
  function setPose(pose, opts = {}) {
    mode = pose;
    if (pose === 'sit-drive') {
      lean = opts.lean != null ? opts.lean : DRIVE_POSE.lean;
      root.rotation.x = -lean; // 躯干后仰
      poseLimbs(
        _vHandL.copy(toLocal(opts.handL || DRIVE_POSE.handL)),
        _vHandR.copy(toLocal(opts.handR || DRIVE_POSE.handR)),
        _vFootL.copy(toLocal(opts.footL || DRIVE_POSE.footL)),
        _vFootR.copy(toLocal(opts.footR || DRIVE_POSE.footR)),
      );
    } else if (pose === 'stand') {
      lean = 0;
      root.rotation.x = 0;
      poseLimbs(
        _vHandL.set(L.shoulderW + 0.04 * k, -0.10 * k, 0.02 * k),
        _vHandR.set(-L.shoulderW - 0.04 * k, -0.10 * k, 0.02 * k),
        _vFootL.set(L.hipW, -L.hipY + 0.04 * k, 0),
        _vFootR.set(-L.hipW, -L.hipY + 0.04 * k, 0),
      );
    }
    return api;
  }
  // 步态（three-procedural-locomotion：步频跟速度/腿长走；摆臂与腿反相；
  // 骨盆/肩反向扭转；身体起伏；头预判转向由 setLook 给）。
  function poseWalk(dt) {
    walkPhase += dt * walkSpeed * 5.0 / (L.thigh + L.shin);
    const stride = 0.32 * Math.min(1, walkSpeed / 1.7) + 0.18;
    const swL = Math.sin(walkPhase) * stride;
    const swR = Math.sin(walkPhase + Math.PI) * stride;
    const liftL = Math.max(0, Math.sin(walkPhase + Math.PI * 0.5)) * 0.09;
    const liftR = Math.max(0, Math.sin(walkPhase + Math.PI * 1.5)) * 0.09;
    const bob = Math.abs(Math.cos(walkPhase)) * 0.03;
    root.position.y = L.hipY + bob;
    poseLimbs(
      _vHandL.set(L.shoulderW + 0.04 * k, -0.10 * k - Math.sin(walkPhase + Math.PI) * 0.12, 0.02 * k),
      _vHandR.set(-L.shoulderW - 0.04 * k, -0.10 * k - Math.sin(walkPhase) * 0.12, 0.02 * k),
      _vFootL.set(L.hipW, -L.hipY + 0.04 * k + liftL, swL),
      _vFootR.set(-L.hipW, -L.hipY + 0.04 * k + liftR, swR),
    );
    spine.rotation.y = Math.sin(walkPhase) * 0.08;
  }
  let lookYaw = 0, lookPitch = 0, lookYawT = 0, lookPitchT = 0;
  function setLook(yaw, pitch = 0) { lookYawT = yaw; lookPitchT = pitch; return api; }
  function setWalk(speed) {
    walkSpeed = speed;
    if (speed > 0.1 && mode !== 'walk') { mode = 'walk'; lean = 0; root.rotation.x = 0; }
    else if (speed <= 0.1 && mode === 'walk') { mode = 'stand'; setPose('stand'); }
    return api;
  }
  // 眨眼：2.4–5s 一次，闭 0.12s（独立变量，不污染 exprTarget，否则眨一次就合不上）。
  let nextBlink = 2.5, blinkT = -1, _blink = 0;
  function update(dt, t) {
    mixer.update(dt); // 先播 clip，再写程序化骨骼（threejs-animation 规则）
    if (t >= nextBlink) { blinkT = t; nextBlink = t + 2.4 + ((t * 13.7) % 2.4); }
    _blink = (blinkT >= 0 && t - blinkT < 0.12) ? 1 : 0;
    for (const n of FACE_SHAPES) {
      const target = Math.max(0, Math.min(1, exprTarget[n] + visTarget[n]));
      face[n] += (target - face[n]) * Math.min(1, dt * 8);
    }
    applyFace();
    lookYaw += (lookYawT - lookYaw) * Math.min(1, dt * 5);
    lookPitch += (lookPitchT - lookPitch) * Math.min(1, dt * 5);
    head.rotation.y = lookYaw;
    head.rotation.x = lookPitch;
    if (mode === 'walk') poseWalk(dt);
  }
  const api = {
    group: root, spec: s, lengths: L, mixer, slots: ANIMATION_SLOTS,
    joints: { spine, neck, head, jaw, armL, armR, legL, legR },
    setPose, setWalk, setLook, setExpression, setViseme, setRhubarbCue, update,
    get expression() { return expression; },
    get viseme() { return viseme; },
    get mode() { return mode; },
    faceWeights: () => ({ ...face }),
  };
  setPose('stand');
  applyFace();
  return api;
}

function buildPedestrians() {
  pedestrians = [];
  // 按 weight 分配人数
  const totalW = STREET_SEGMENTS.reduce((s, g) => s + g.weight, 0);
  let idx = 0;
  for (const seg of STREET_SEGMENTS) {
    const n = Math.max(2, Math.round((seg.weight / totalW) * COUNT));
    for (let i = 0; i < n && idx < COUNT; i++, idx++) {
      const rnd = mulberry32(0x9E3779B9 + idx * 7919);
      const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
      pedestrians.push({
        seed: idx,
        seg,
        t: rnd(),                       // 沿街位置
        dir: rnd() < 0.5 ? 1 : -1,       // 往返方向
        side: (rnd() < 0.5 ? -1 : 1) * (4.5 + rnd() * 2.5), // 人行道一侧
        speed: 0.9 + rnd() * 0.6,        // 0.9–1.5 m/s
        phase: rnd() * Math.PI * 2,
        stride: 0.5 + rnd() * 0.18,      // 摆腿幅度
        armSwing: 0.32 + rnd() * 0.18,
        scale: 0.92 + rnd() * 0.16,      // 身高 1.58–1.86m
        skin: SKINS[Math.floor(rnd() * SKINS.length)],
        jacket: JACKETS[Math.floor(rnd() * JACKETS.length)],
        pants: PANTS[Math.floor(rnd() * PANTS.length)],
        hair: HAIRS[Math.floor(rnd() * HAIRS.length)],
        hairLong: rnd() < 0.35,          // 长发 35%
        neon: rnd() < 0.45 ? NEON[Math.floor(rnd() * NEON.length)] : 0, // 45% 有霓虹胸条
        ...pedestrianBodyParams(idx), // 体型/衣服/步态（派生子流，旧字段值不动）
        heading: 0,
        x: 0, z: 0, y: 0,
        bob: 0,
        headYaw: 0, // 头预判转向（three-procedural-locomotion：头/胸先于脚转向）
      });
    }
  }
  // 补齐到 COUNT（上面取整可能少 1–2 个）
  while (pedestrians.length < COUNT) {
    const seg = STREET_SEGMENTS[0];
    const rnd = mulberry32(1234 + pedestrians.length * 31);
    pedestrians.push({
      seed: pedestrians.length, seg, t: rnd(), dir: 1, side: 5 + rnd() * 2,
      speed: 1.0 + rnd() * 0.4, phase: rnd() * 6.28, stride: 0.55, armSwing: 0.38,
      scale: 0.95 + rnd() * 0.1, skin: SKINS[0], jacket: JACKETS[0], pants: PANTS[0],
      hair: HAIRS[0], hairLong: false, neon: 0, ...pedestrianBodyParams(pedestrians.length),
      heading: 0, x: 0, z: 0, y: 0, bob: 0, headYaw: 0,
    });
  }
  for (const p of pedestrians) {
    const pt = segPoint(p.seg, p.t, p.side);
    p.x = pt.x; p.z = pt.z; p.y = groundY(pt.x, pt.z);
    p.heading = pt.heading + (p.dir < 0 ? Math.PI : 0);
  }
  // ---- 第二拨：街头生活行人（16 人；48 人原样不动，在后面追加） ----
  // 姿态四种：遛狗（牵狗慢走）、买菜（提菜篮慢走）、等车（路边站着、四处张望）、
  // 看手机（低头、单手举手机慢走）。每人种子不同，衣服/发型/肤色/身高/步速全变，
  // 绝无 5 个一模一样的排一列；道具（狗/菜篮/手机）也是程序化拼装，不是胶囊人。
  const segById = Object.fromEntries(STREET_SEGMENTS.map((s) => [s.id, s]));
  const lifeKinds = [
    ...['S1', 'S2', 'S3', 'S5'].map((segId) => ({ life: 'dog', segId })),
    ...['S1', 'S3', 'S4', 'S2'].map((segId) => ({ life: 'bag', segId })),
    ...['S2', 'S3', 'S5', 'S1'].map((segId) => ({ life: 'phone', segId })),
    ...['S1', 'S3', 'S2', 'S4'].map((segId) => ({ life: 'wait', segId })),
  ];
  const DOG_COATS = [0x8B5A2B, 0x2A2A2E, 0xD9C8A8, 0x6B4423];
  const BAG_COLS = [0xC75B12, 0x1F6B4A, 0x8B2E5E, 0x274B63];
  const WAIT_T = [0.5, 0.3, 0.5, 0.7]; // 4 个等车人的固定站位（沿街位置）
  lifeKinds.forEach((def, k) => {
    const idx = pedestrians.length;
    const rnd = mulberry32(0x11FE + idx * 104729);
    const seg = segById[def.segId];
    const p = {
      seed: idx, seg,
      t: def.life === 'wait' ? WAIT_T[k - 12] : rnd(),
      dir: rnd() < 0.5 ? 1 : -1,
      side: (rnd() < 0.5 ? -1 : 1) * (4.5 + rnd() * 2.5),
      speed: def.life === 'dog' ? 0.7 + rnd() * 0.3 : def.life === 'bag' ? 0.8 + rnd() * 0.3 : def.life === 'phone' ? 0.6 + rnd() * 0.25 : 0,
      phase: rnd() * Math.PI * 2,
      stride: 0.5 + rnd() * 0.18,
      armSwing: 0.32 + rnd() * 0.18,
      scale: 0.92 + rnd() * 0.16,
      skin: SKINS[Math.floor(rnd() * SKINS.length)],
      jacket: JACKETS[Math.floor(rnd() * JACKETS.length)],
      pants: PANTS[Math.floor(rnd() * PANTS.length)],
      hair: HAIRS[Math.floor(rnd() * HAIRS.length)],
      hairLong: rnd() < 0.35,
      neon: rnd() < 0.45 ? NEON[Math.floor(rnd() * NEON.length)] : 0,
      heading: 0, x: 0, z: 0, y: 0, bob: 0, headYaw: 0,
      life: def.life,
      dogColor: DOG_COATS[k % DOG_COATS.length],
      dogScale: 0.7 + rnd() * 0.5,
      bagColor: BAG_COLS[k % BAG_COLS.length],
      bagSide: rnd() < 0.5 ? -1 : 1,
      waitPhone: def.life === 'wait' && (k % 2 === 0), // 4 个等车人里 2 个低头看手机
      ...pedestrianBodyParams(idx),
    };
    if (def.life === 'wait') { p.side = (k % 2 === 0 ? 1 : -1) * 6; p.dir = 1; }
    pedestrians.push(p);
    const pt = segPoint(p.seg, p.t, p.side);
    p.x = pt.x; p.z = pt.z; p.y = groundY(pt.x, pt.z);
    p.heading = pt.heading + (p.dir < 0 ? Math.PI : 0);
  });
  // 道具序号（狗/菜篮/手机各一个 InstancedMesh，按 life 拨内序号排）
  let _d = 0, _b = 0, _p = 0;
  for (const p of pedestrians) {
    if (p.life === 'dog') p.propIndex = _d++;
    else if (p.life === 'bag') p.propIndex = _b++;
    else if (p.life === 'phone' || (p.life === 'wait' && p.waitPhone)) p.propIndex = _p++;
  }
}

function box(w, h, d, x, y, z) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

function buildMeshes() {
  const THREE_ = ctx.THREE;
  group = new THREE_.Group();
  group.name = 'surpass-people';

  // 腿：盒 + 鞋合并，几何原点在髋关节（绕髋摆动）
  const legGeo = mergeGeometries([
    box(0.14, 0.82, 0.16, 0, -0.41, 0),
    box(0.15, 0.08, 0.30, 0, -0.82, 0.05),
  ]);
  // 臂：几何原点在肩关节
  const armGeo = box(0.10, 0.62, 0.12, 0, -0.31, 0);
  const torsoGeo = new THREE_.BoxGeometry(0.44, 0.58, 0.26);
  const headGeo = new THREE_.SphereGeometry(0.115, 14, 10);
  const hairCapGeo = new THREE_.SphereGeometry(0.125, 12, 8, 0, Math.PI * 2, 0, 1.25);
  // 发盖下沿 θ=1.25rad（≈72°）：眼睛在 θ≈85° 处，下沿停在眼睛上方，不盖眼。
  // 之前 1.9rad（≈109°）下沿盖到眼下，眼睛被发盖遮住。
  hairCapGeo.scale(1, 0.9, 1);
  const hairLongGeo = box(0.26, 0.36, 0.10, 0, -0.10, -0.09);
  const eyeGeo = new THREE_.SphereGeometry(0.016, 6, 5);
  const accentGeo = new THREE_.BoxGeometry(0.46, 0.05, 0.28);
  // 新增件：眉（×2）/ 口 / 帽 / 背包——体型参数化的脸与衣（各 +1 draw call）。
  const browGeo = new THREE_.BoxGeometry(0.05, 0.012, 0.014);
  const mouthGeo = new THREE_.BoxGeometry(0.055, 0.01, 0.012);
  const hatDome = new THREE_.SphereGeometry(0.125, 10, 6, 0, Math.PI * 2, 0, 1.35);
  hatDome.scale(1, 0.9, 1);
  const hatGeo = mergeGeometries([hatDome, box(0.16, 0.015, 0.10, 0, 0.02, 0.14)]);
  const packGeo = mergeGeometries([
    box(0.30, 0.38, 0.12, 0, 0, 0),
    box(0.30, 0.10, 0.13, 0, 0.16, 0),
  ]);

  const mat = (color, opts = {}) => new THREE_.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.05, ...opts });
  const mk = (geo, material, count) => {
    const m = new THREE_.InstancedMesh(geo, material, count);
    m.instanceMatrix.setUsage(THREE_.DynamicDrawUsage);
    m.frustumCulled = false;
    group.add(m);
    return m;
  };
  parts = {
    torso: mk(torsoGeo, mat(0xffffff), TOTAL),
    head: mk(headGeo, mat(0xffffff), TOTAL),
    hairCap: mk(hairCapGeo, mat(0xffffff), TOTAL),
    hairLong: mk(hairLongGeo, mat(0xffffff), TOTAL),
    legL: mk(legGeo, mat(0xffffff), TOTAL),
    legR: mk(legGeo, mat(0xffffff), TOTAL),
    armL: mk(armGeo, mat(0xffffff), TOTAL),
    armR: mk(armGeo, mat(0xffffff), TOTAL),
    eyes: mk(eyeGeo, new THREE_.MeshBasicMaterial({ color: 0x111111 }), TOTAL * 2),
    accent: mk(accentGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), TOTAL),
    brows: mk(browGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), TOTAL * 2),
    mouth: mk(mouthGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), TOTAL),
    hat: mk(hatGeo, mat(0xffffff), TOTAL),
    pack: mk(packGeo, mat(0xffffff), TOTAL),
  };

  // 第二拨道具：狗 / 菜篮 / 手机（程序化拼装，近看有物；原点说明见各几何）
  // 狗：身 + 头 + 嘴 + 双耳 + 四腿 + 竖尾，原点在地面中心，朝向 +Z。
  const dogGeo = mergeGeometries([
    box(0.18, 0.2, 0.44, 0, 0.32, 0),
    box(0.16, 0.16, 0.18, 0, 0.44, 0.28),
    box(0.08, 0.08, 0.12, 0, 0.4, 0.4),
    box(0.05, 0.1, 0.05, -0.06, 0.54, 0.26),
    box(0.05, 0.1, 0.05, 0.06, 0.54, 0.26),
    box(0.05, 0.22, 0.05, -0.07, 0.11, 0.14),
    box(0.05, 0.22, 0.05, 0.07, 0.11, 0.14),
    box(0.05, 0.22, 0.05, -0.07, 0.11, -0.14),
    box(0.05, 0.22, 0.05, 0.07, 0.11, -0.14),
    box(0.04, 0.2, 0.04, 0, 0.42, -0.26),
  ]);
  // 菜篮：袋身 + 双提手，原点在提手握点，袋身垂在下方。
  const bagGeo = mergeGeometries([
    box(0.22, 0.34, 0.12, 0, -0.28, 0),
    box(0.02, 0.14, 0.02, -0.07, -0.06, 0),
    box(0.02, 0.14, 0.02, 0.07, -0.06, 0),
    box(0.16, 0.02, 0.02, 0, 0.01, 0),
  ]);
  // 手机：小方块，亮屏（Basic 材质本色发光）。
  const phoneGeo = new THREE_.BoxGeometry(0.07, 0.14, 0.015);
  props = {
    dog: mk(dogGeo, mat(0xffffff), 4),
    bag: mk(bagGeo, mat(0xffffff), 4),
    phone: mk(phoneGeo, new THREE_.MeshBasicMaterial({ color: 0xffffff }), 6),
  };
  const PHONE_COLS = [0x7DF9FF, 0xFFD166, 0xE8F0FF];
  propOrigColors = {};
  const setPC = (mesh, i, hex) => {
    mesh.setColorAt(i, c.setHex(hex));
    (propOrigColors[mesh.uuid] = propOrigColors[mesh.uuid] || {})[i] = hex;
  };
  // 道具颜色在下面 const c 声明之后统一赋（setPC 只定义、不立即调用，避免 TDZ）。

  // 每实例颜色（种子定死）
  const c = new THREE_.Color();
  origColors = {};
  const setC = (mesh, i, hex) => {
    mesh.setColorAt(i, c.setHex(hex));
    (origColors[mesh.uuid] = origColors[mesh.uuid] || {})[i] = hex;
  };
  pedestrians.forEach((p, i) => {
    setC(parts.torso, i, p.jacket);
    setC(parts.head, i, p.skin);
    setC(parts.legL, i, p.pants);
    setC(parts.legR, i, p.pants);
    setC(parts.armL, i, p.jacket);
    setC(parts.armR, i, p.jacket);
    setC(parts.hairCap, i, p.hair);
    setC(parts.hairLong, i, p.hair);
    setC(parts.accent, i, p.neon || 0x000000);
    setC(parts.brows, i * 2, p.hair);
    setC(parts.brows, i * 2 + 1, p.hair);
    setC(parts.mouth, i, p.mouthColor);
    setC(parts.hat, i, p.hatColor);
    setC(parts.pack, i, p.packColor);
  });
  for (const m of Object.values(parts)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  // 第二拨道具颜色（每只狗/每个菜篮/每部手机颜色不同）
  pedestrians.forEach((p) => {
    if (p.life === 'dog') setPC(props.dog, p.propIndex, p.dogColor);
    else if (p.life === 'bag') setPC(props.bag, p.propIndex, p.bagColor);
    else if (p.life === 'phone' || (p.life === 'wait' && p.waitPhone)) setPC(props.phone, p.propIndex, PHONE_COLS[p.propIndex % PHONE_COLS.length]);
  });
  for (const m of Object.values(props)) if (m.instanceColor) m.instanceColor.needsUpdate = true;
  ctx.scene.add(group);
}

const _root = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

function setPart(mesh, i, rootM, px, py, pz, rx, ry, rz, sx = 1, sy = 1, sz = 1) {
  _e.set(rx, ry, rz);
  _q.setFromEuler(_e);
  _v.set(px, py, pz);
  _s.set(sx, sy, sz);
  _local.compose(_v, _q, _s);
  _m.multiplyMatrices(rootM, _local);
  mesh.setMatrixAt(i, _m);
}

function update(dt) {
  if (!parts) return;
  const tNow = performance.now() / 1000;
  for (let i = 0; i < pedestrians.length; i++) {
    const p = pedestrians[i];
    const isWait = p.life === 'wait';
    const isPhone = p.life === 'phone' || (isWait && p.waitPhone);
    const isBag = p.life === 'bag';
    const isDog = p.life === 'dog';
    // 沿街走，到端点掉头；等车人站着不动，只四处张望
    const segLen = Math.hypot(p.seg.b[0] - p.seg.a[0], p.seg.b[1] - p.seg.a[1]);
    if (!isWait) {
      p.t += (p.dir * p.speed * dt) / segLen;
      if (p.t > 0.98) { p.t = 0.98; p.dir = -1; }
      if (p.t < 0.02) { p.t = 0.02; p.dir = 1; }
    }
    const pt = segPoint(p.seg, p.t, p.side);
    // 朝向平滑转向（掉头不瞬切）
    const targetHeading = pt.heading + (p.dir < 0 ? Math.PI : 0);
    let dh = targetHeading - p.heading;
    while (dh > Math.PI) dh -= Math.PI * 2;
    while (dh < -Math.PI) dh += Math.PI * 2;
    p.heading += dh * Math.min(1, dt * 4);
    // three-procedural-locomotion：按剩余转角减速（掉头时步子放慢），
    // 头/胸预判新朝向（头先转，胸跟一半，脚最后到位）。
    // 等车人：头慢慢左右张望（看车来了没有），身体轻微晃。
    const turnFactor = 1 - Math.min(1, Math.abs(dh) / Math.PI) * 0.5;
    const headTarget = isWait
      ? Math.sin(tNow * 0.45 + p.seed * 1.7) * 0.5
      : Math.max(-0.35, Math.min(0.35, dh * 0.5));
    p.headYaw += (headTarget - p.headYaw) * Math.min(1, dt * (isWait ? 3 : 6));
    p.x = pt.x; p.z = pt.z;
    p.y = groundY(p.x, p.z);
    // 步态：摆腿 / 摆臂 / 身体起伏（three-procedural-locomotion 的逐帧思路）。
    // 步频跟速度走、跟腿长走（腿长 ∝ scale，步频 ∝ speed / scale）；转弯时减速。
    // 等车人站着：不迈腿，只用 phase 当轻晃时钟。
    // 步频跟速度/腿长走（three-procedural-locomotion：cadence ∝ speed / legLength）；
    // 步态预设（heavy/athletic/tired）改速率/起伏/摆臂。
    if (!isWait) p.phase += dt * p.speed * 4.8 * turnFactor * p.gaitM.rate / (p.scale * p.legLen);
    else p.phase += dt * 0.9;
    const sw = isWait ? 0 : Math.sin(p.phase) * p.stride * p.gaitM.stride;
    const sw2 = isWait ? 0 : Math.sin(p.phase + Math.PI) * p.stride * p.gaitM.stride;
    const armSw = isWait ? Math.sin(p.phase) * 0.04 : Math.sin(p.phase + Math.PI) * p.armSwing * p.gaitM.arm;
    const armSw2 = isWait ? Math.sin(p.phase + 1) * 0.04 : Math.sin(p.phase) * p.armSwing * p.gaitM.arm;
    p.bob = isWait ? 0 : Math.abs(Math.cos(p.phase)) * 0.035 * p.gaitM.bob;
    const hip = 0.88 * p.scale * p.legLen; // 腿长改髋高（腿短的人矮一截）
    const s = p.scale;
    _e.set(0, p.heading, 0);
    _q.setFromEuler(_e);
    _v.set(p.x, p.y + p.bob, p.z);
    _s.set(s, s, s);
    _root.compose(_v, _q, _s);
    // 腿：髋宽改落点与粗细，腿长改长度。
    setPart(parts.legL, i, _root, -0.11 * p.hip, hip, 0, sw, 0, 0, p.hip, p.legLen, 1);
    setPart(parts.legR, i, _root, 0.11 * p.hip, hip, 0, sw2, 0, 0, p.hip, p.legLen, 1);
    const shoulderY = hip + 0.52 * p.torsoLen;
    const armSX = -0.28 * p.shoulder, armDX = 0.28 * p.shoulder;
    // 手臂：看手机的人右臂屈起举手机；提菜篮的人提篮那侧手臂少摆、篮子跟着晃；
    // 等车人手臂自然下垂轻晃。
    if (isPhone) {
      setPart(parts.armL, i, _root, armSX, shoulderY, 0, armSw, 0, 0.08, p.armThick, 1, p.armThick);
      setPart(parts.armR, i, _root, armDX, shoulderY, 0, -1.05, 0, -0.12, p.armThick, 1, p.armThick);
    } else if (isBag && p.bagSide < 0) {
      setPart(parts.armL, i, _root, armSX, shoulderY, 0, armSw * 0.25, 0, 0.08, p.armThick, 1, p.armThick);
      setPart(parts.armR, i, _root, armDX, shoulderY, 0, armSw2, 0, -0.08, p.armThick, 1, p.armThick);
    } else if (isBag) {
      setPart(parts.armL, i, _root, armSX, shoulderY, 0, armSw, 0, 0.08, p.armThick, 1, p.armThick);
      setPart(parts.armR, i, _root, armDX, shoulderY, 0, armSw2 * 0.25, 0, -0.08, p.armThick, 1, p.armThick);
    } else {
      setPart(parts.armL, i, _root, armSX, shoulderY, 0, armSw, 0, 0.08, p.armThick, 1, p.armThick);
      setPart(parts.armR, i, _root, armDX, shoulderY, 0, armSw2, 0, -0.08, p.armThick, 1, p.armThick);
    }
    const lean = isWait ? Math.sin(p.phase) * 0.03 : p.gaitM.lean;
    // 躯干：肩宽/躯干长/腹围各异（tee 短、coat 长盖髋）。
    setPart(parts.torso, i, _root, 0, hip + 0.29 * p.torsoLen, 0, lean, p.headYaw * 0.5, Math.sin(p.phase) * 0.04, p.shoulder, p.torsoLen, p.belly);
    const headY = hip + 0.58 * p.torsoLen + 0.14;
    // 看手机的人低头（rx 正值 = 脸朝下）；发盖跟着头一起俯仰，不歪。
    const headPitch = isPhone ? 0.26 : -0.04;
    setPart(parts.head, i, _root, 0, headY, 0, headPitch, p.headYaw, 0);
    // 发盖长短发都有（长发只留脑后发片会秃顶）；长发再加脑后发片。
    setPart(parts.hairCap, i, _root, 0, headY + 0.02, -0.01, headPitch, 0, 0);
    if (p.hairLong) {
      setPart(parts.hairLong, i, _root, 0, headY + 0.02, 0, headPitch, 0, 0);
    } else {
      setPart(parts.hairLong, i, _root, 0, 0, 0, 0, 0, 0, 0.001, 0.001, 0.001);
    }
    // 眼睛：两颗，朝向与身体一致（在 root 空间里 z+ 为脸朝向）
    setPart(parts.eyes, i * 2, _root, -0.045, headY + 0.01, 0.105, 0, 0, 0);
    setPart(parts.eyes, i * 2 + 1, _root, 0.045, headY + 0.01, 0.105, 0, 0, 0);
    // 眉/口/帽/包：眉形按种子歪（怒/愁各异），口色按种子变；无帽/无包的缩到 0 藏起。
    setPart(parts.brows, i * 2, _root, -0.045, headY + 0.045, 0.105, headPitch, p.headYaw, p.browTilt);
    setPart(parts.brows, i * 2 + 1, _root, 0.045, headY + 0.045, 0.105, headPitch, p.headYaw, -p.browTilt);
    setPart(parts.mouth, i, _root, 0, headY - 0.045, 0.108, headPitch, p.headYaw, 0);
    const hatS = p.hat === 'cap' ? 1 : 0.001;
    setPart(parts.hat, i, _root, 0, headY + 0.02, -0.005, headPitch, p.headYaw, 0, hatS, hatS, hatS);
    const packS = p.pack ? 1 : 0.001;
    setPart(parts.pack, i, _root, 0, hip + 0.32 * p.torsoLen, -0.13 * p.belly - 0.07, lean, 0, 0, packS, packS, packS);
    // 霓虹胸条：无霓虹的行人缩到 0 藏起
    const nScale = p.neon ? 1 : 0.001;
    setPart(parts.accent, i, _root, 0, hip + 0.38, 0, 0.06, 0, 0, nScale, nScale, nScale);
    // 第二拨道具：狗跟在主人身后偏右、菜篮挂在提篮的手上、手机举在脸前
    if (props) {
      if (isDog) {
        const fx = Math.sin(p.heading), fz = Math.cos(p.heading);
        const rx = Math.cos(p.heading), rz = -Math.sin(p.heading);
        const dx = p.x - fx * 0.85 + rx * 0.4, dz = p.z - fz * 0.85 + rz * 0.4;
        _e.set(0, p.heading + Math.sin(tNow + p.phase) * 0.15, 0);
        _q.setFromEuler(_e);
        _v.set(dx, groundY(dx, dz) + Math.abs(Math.cos(p.phase)) * 0.03, dz);
        _s.set(p.dogScale, p.dogScale, p.dogScale);
        _m.compose(_v, _q, _s);
        props.dog.setMatrixAt(p.propIndex, _m);
      } else if (isBag) {
        setPart(props.bag, p.propIndex, _root, p.bagSide * 0.28, hip - 0.10 + Math.sin(p.phase) * 0.04, 0.03, armSw * 0.3, 0, 0);
      }
      if (isPhone) {
        setPart(props.phone, p.propIndex, _root, 0.28, hip + 0.95, 0.30, -0.35, 0, 0.1);
      }
    }
  }
  for (const m of Object.values(parts)) m.instanceMatrix.needsUpdate = true;
  if (props) for (const m of Object.values(props)) m.instanceMatrix.needsUpdate = true;
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
  lastT = now;
  update(dt);
  rafId = requestAnimationFrame(tick);
}

export function init(c) {
  ctx = c;
  buildPedestrians();
  buildMeshes();
  update(0);
  lastT = performance.now();
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(tick);
  window.__people = {
    count: pedestrians.length,
    baseCount: COUNT,
    lifeCount: LIFE_COUNT,
    total: TOTAL,
    group,
    crowdCheck: validateCrowd(pedestrians), // 64 人验重：duplicates 须为 0
    createPlayerModel, PLAYER_SPEC, FACE_SHAPES, EXPRESSIONS, DRIVE_POSE,
    BLENDER_PLAYER_SCRIPT, BLENDER_RUN_CMD, validateCrowd, pedestrianBodyParams,
    getPositions: () => pedestrians.map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), seg: p.seg.id, life: p.life || 'walk' })),
    getLifePositions: () => pedestrians.filter((p) => p.life).map((p) => ({ x: +p.x.toFixed(1), z: +p.z.toFixed(1), seg: p.seg.id, life: p.life })),
    update,
  };
  return { group, count: pedestrians.length, baseCount: COUNT, lifeCount: LIFE_COUNT, total: TOTAL };
}

export function setDisplay(mode) {
  displayMode = mode;
  if (!parts) return;
  const c = new THREE.Color();
  if (mode === 'white') {
    // 白膜：霓虹收起来，全部变回白膜
    for (const [uuid, map] of Object.entries(origColors)) {
      const mesh = Object.values(parts).find((m) => m.uuid === uuid);
      if (!mesh) continue;
      for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(0xffffff));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    parts.accent.visible = false;
    parts.eyes.visible = false;
    parts.brows.visible = false; // 眉/口是脸细节，白膜收起来（同眼睛）
    parts.mouth.visible = false;
    if (props) {
      for (const [uuid, map] of Object.entries(propOrigColors)) {
        const mesh = Object.values(props).find((m) => m.uuid === uuid);
        if (!mesh) continue;
        for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(0xffffff));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      props.phone.visible = false; // 亮屏手机是霓虹件，白膜收起来
    }
  } else {
    for (const [uuid, map] of Object.entries(origColors)) {
      const mesh = Object.values(parts).find((m) => m.uuid === uuid);
      if (!mesh) continue;
      for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(hex));
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    parts.accent.visible = true;
    parts.eyes.visible = true;
    parts.brows.visible = true;
    parts.mouth.visible = true;
    if (props) {
      for (const [uuid, map] of Object.entries(propOrigColors)) {
        const mesh = Object.values(props).find((m) => m.uuid === uuid);
        if (!mesh) continue;
        for (const [i, hex] of Object.entries(map)) mesh.setColorAt(+i, c.setHex(hex));
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
      props.phone.visible = true;
    }
  }
}

export function getCount() { return pedestrians.length; }
export function getBaseCount() { return COUNT; }
export function getLifeCount() { return LIFE_COUNT; }
