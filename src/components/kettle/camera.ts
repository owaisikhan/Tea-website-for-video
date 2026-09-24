// Orbit camera for the ray-traced kettle, shared by the page and the headless renderer.

export type Vec3 = [number, number, number];

export type KettleView = {
  cam_pos: Vec3;
  cam_fwd: Vec3;
  cam_right: Vec3;
  cam_up: Vec3;
  tan_half_fov: number;
};

const TARGET: Vec3 = [-0.15, 1.02, 0];
const FOV = 34;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** yaw 0 looks at the pot from the front (+z), pitch lifts the camera. */
export function kettleView(yaw: number, pitch: number, radius: number): KettleView {
  const cp = Math.cos(pitch);
  const pos: Vec3 = [
    TARGET[0] + Math.sin(yaw) * cp * radius,
    TARGET[1] + Math.sin(pitch) * radius,
    TARGET[2] + Math.cos(yaw) * cp * radius,
  ];
  const fwd = norm(sub(TARGET, pos));
  const right = norm(cross(fwd, [0, 1, 0]));
  const up = cross(right, fwd);
  return { cam_pos: pos, cam_fwd: fwd, cam_right: right, cam_up: up, tan_half_fov: Math.tan((FOV * Math.PI) / 360) };
}

export const DEFAULT_VIEW = { yaw: 0.35, pitch: 0.22, radius: 7.2 };
