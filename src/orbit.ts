export interface OrbitView { index: number; azimuth: number; elevation: number; zoom: number; label: string }
export interface OrbitOptions { azimuthSteps: number; elevations: number[]; zoomLevels: number[]; holdSeconds: number; leadSeconds: number; distanceScale: number }

export function orbitViews(options: Pick<OrbitOptions, "azimuthSteps" | "elevations" | "zoomLevels">): OrbitView[] {
  const views: OrbitView[] = [];
  for (const zoom of options.zoomLevels) for (const elevation of options.elevations) for (let step = 0; step < options.azimuthSteps; step++) {
    const azimuth = Number((step * 360 / options.azimuthSteps).toFixed(2));
    views.push({ index: views.length, azimuth, elevation, zoom, label: `${facing(azimuth)} az ${azimuth}° · el ${elevation}°${zoom !== 1 ? ` · ×${zoom}` : ""}` });
  }
  return views;
}

function facing(azimuth: number): string {
  const names = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"];
  return names[Math.round(((azimuth % 360) + 360) % 360 / 45) % 8]!;
}

const luaNumber = (value: number) => Number(value.toFixed(4)).toString();

export function robloxOrbitScript(target: string, views: OrbitView[], options: OrbitOptions): string {
  const list = views.map(v => `{${luaNumber(v.azimuth)}, ${luaNumber(v.elevation)}, ${luaNumber(v.zoom)}}`).join(", ");
  return `local Selection = game:GetService("Selection")
local camera = workspace.CurrentCamera
local targetPath = ${JSON.stringify(target)}
local function resolve(path)
	if path == "selection" then
		return Selection:Get()[1]
	end
	local node = game
	for name in string.gmatch(path, "[^%.]+") do
		local child = node:FindFirstChild(name)
		if not child and node == game then
			local ok, service = pcall(game.GetService, game, name)
			child = ok and service or nil
		end
		if not child then
			return nil
		end
		node = child
	end
	return node
end
local target = resolve(targetPath)
assert(target, "ClipQA orbit target not found: " .. targetPath)
local pivot, size
if target:IsA("Model") then
	pivot, size = target:GetBoundingBox()
elseif target:IsA("BasePart") then
	pivot, size = target.CFrame, target.Size
else
	error("ClipQA orbit target must be a Model or BasePart")
end
Selection:Set({})
local views = {${list}}
local previousType, previousCFrame, previousFocus = camera.CameraType, camera.CFrame, camera.Focus
local distance = size.Magnitude * 0.5 / math.tan(math.rad(camera.FieldOfView) * 0.5) * ${luaNumber(options.distanceScale)}
local center = pivot.Position
task.spawn(function()
	camera.CameraType = Enum.CameraType.Scriptable
	for index, view in ipairs(views) do
		local azimuth, elevation = math.rad(view[1]), math.rad(view[2])
		local localOffset = Vector3.new(math.sin(azimuth) * math.cos(elevation), math.sin(elevation), -math.cos(azimuth) * math.cos(elevation))
		local offset = pivot:VectorToWorldSpace(localOffset) * (distance / view[3])
		local up = math.abs(view[2]) > 80 and pivot.LookVector * -math.sign(view[2]) or Vector3.yAxis
		camera.CFrame = CFrame.lookAt(center + offset, center, up)
		camera.Focus = CFrame.new(center)
		print(string.format("CLIPQA_ORBIT %d az=%s el=%s zoom=%s", index, view[1], view[2], view[3]))
		task.wait(index == 1 and ${luaNumber(options.leadSeconds + options.holdSeconds)} or ${luaNumber(options.holdSeconds)})
	end
	camera.CameraType = previousType
	camera.CFrame = previousCFrame
	camera.Focus = previousFocus
	print("CLIPQA_ORBIT done")
end)
return string.format("ClipQA orbit started: %d views, about %.1f seconds", #views, ${luaNumber(options.leadSeconds)} + #views * ${luaNumber(options.holdSeconds)})
`;
}

export function blenderOrbitScript(target: string, views: OrbitView[], options: OrbitOptions): string {
  const list = views.map(v => `(${v.azimuth}, ${v.elevation}, ${v.zoom})`).join(", ");
  return `import bpy
import math
from mathutils import Euler, Vector

TARGET = ${JSON.stringify(target === "selection" ? "" : target)}
VIEWS = [${list}]
HOLD = ${options.holdSeconds}
LEAD = ${options.leadSeconds}

root = bpy.data.objects.get(TARGET) if TARGET else bpy.context.active_object
if root is None:
    raise RuntimeError("ClipQA orbit target not found")
objects = [root] + [o for o in root.children_recursive if o.type in {"MESH", "CURVE", "SURFACE", "META", "FONT"}]
corners = [o.matrix_world @ Vector(c) for o in objects for c in o.bound_box]
low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
center = (low + high) / 2
distance = (high - low).length * 0.5 / math.tan(math.radians(25)) * ${options.distanceScale}
area = next(a for a in bpy.context.screen.areas if a.type == "VIEW_3D")
view = area.spaces.active.region_3d
saved = (view.view_location.copy(), view.view_rotation.copy(), view.view_distance, view.view_perspective)
for o in bpy.context.selected_objects:
    o.select_set(False)
state = {"index": 0}

def step():
    index = state["index"]
    if index >= len(VIEWS):
        view.view_location, view.view_rotation, view.view_distance, view.view_perspective = saved
        area.tag_redraw()
        print("CLIPQA_ORBIT done")
        return None
    azimuth, elevation, zoom = VIEWS[index]
    view.view_perspective = "PERSP"
    view.view_location = center
    view.view_rotation = Euler((math.radians(90 - elevation), 0, math.radians(azimuth)), "XYZ").to_quaternion()
    view.view_distance = distance / zoom
    area.tag_redraw()
    print(f"CLIPQA_ORBIT {index + 1} az={azimuth} el={elevation} zoom={zoom}")
    state["index"] += 1
    return HOLD + (LEAD if index == 0 else 0)

bpy.app.timers.register(step, first_interval=0.01)
`;
}

// Expected view start times anchored at the first camera cut, refined to the nearest detected cut.
export function locateViews(scores: number[], fps: number, seriesStart: number, viewCount: number, options: Pick<OrbitOptions, "holdSeconds" | "leadSeconds">, searchFrom: number, cutThreshold = .06): { timestamps: number[]; anchor: number; matchedCuts: number; warnings: string[] } {
  const warnings: string[] = [];
  const cuts: number[] = [];
  const minGap = Math.max(1, Math.round(options.holdSeconds * fps * .3));
  for (let i = 1; i < scores.length; i++) {
    if (scores[i]! < cutThreshold) continue;
    const time = seriesStart + i / fps;
    if (time < searchFrom) continue;
    if (cuts.length && (time - cuts.at(-1)!) * fps < minGap) continue;
    cuts.push(time);
  }
  if (!cuts.length) throw new Error("No camera cuts found. Start recording before running the orbit script, keep the target visible, and check that the clip covers the orbit.");
  const anchor = cuts[0]!;
  const tolerance = options.holdSeconds * .4;
  let matchedCuts = 0;
  const timestamps: number[] = [];
  for (let i = 0; i < viewCount; i++) {
    const expected = i === 0 ? anchor : anchor + options.leadSeconds + options.holdSeconds * i;
    const nearest = cuts.reduce((best, cut) => Math.abs(cut - expected) < Math.abs(best - expected) ? cut : best, cuts[0]!);
    const begin = i > 0 && Math.abs(nearest - expected) <= tolerance ? (matchedCuts++, nearest) : expected;
    const hold = i === 0 ? options.leadSeconds + options.holdSeconds : options.holdSeconds;
    timestamps.push(Number((begin + hold * .7).toFixed(3)));
  }
  if (matchedCuts < (viewCount - 1) * .6) warnings.push(`Only ${matchedCuts}/${viewCount - 1} view changes were detected; the remaining views use the planned timing. Check the sheet for repeated or transitional frames.`);
  return { timestamps, anchor, matchedCuts, warnings };
}
