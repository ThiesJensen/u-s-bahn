import json
import math
import re
import sys
from bisect import bisect_left, bisect_right
from pathlib import Path

import osmium

ROOT = Path(__file__).resolve().parent.parent
LON0, LAT0 = 13.4, 52.5
KX, KY = 111320 * math.cos(math.radians(LAT0)), 110574
STEP, GRADE, NEAR, SHORT, TOLERANCE = 5, 0.04, 20, 80, 2
TUNNEL, TUNNEL_STEP, BRIDGE, BRIDGE_STEP, CUTTING, EMBANKMENT = -7, -5, 7, 6, -4, 3
ROOF, NARROW, CLEAR, SHARED, RAMP, STACK = -4.5, 4.9, 6, 4, 60, 500
KNOWN = {
    ('Gleisdreieck', 'U1'): 15, ('Gleisdreieck', 'U3'): 15, ('Gleisdreieck', 'U2'): 10,
    ('Alexanderplatz', 'U2'): -4.9, ('Alexanderplatz', 'U8'): -6.6, ('Alexanderplatz', 'U5'): -11.3,
    ('Hauptbahnhof', 'S3'): 10, ('Hauptbahnhof', 'S5'): 10, ('Hauptbahnhof', 'S7'): 10, ('Hauptbahnhof', 'S9'): 10,
    ('Hauptbahnhof', 'S15'): -15, ('Hauptbahnhof', 'U5'): -15,
    ('Unter den Linden', 'U5'): -14, ('Unter den Linden', 'U6'): -5, ('Museumsinsel', 'U5'): -16,
    ('Mehringdamm', 'U7'): -12, ('Kaiserdamm', 'U2'): -4,
}

network = json.loads((ROOT / 'public/data/network.json').read_text())
lines = {line['id']: line for line in network['lines']}
stations = {station['id']: station for station in network['stations']}
by_ifopt = {i: station['id'] for station in network['stations'] for i in station['ids']}
norm = lambda name: re.sub(r'[^a-z0-9äöüß]', '', re.sub(r'^((s\+u|s|u) )?(berlin )?|\s*\((berlin|bei berlin)\)$|\s*bhf$', '', name.lower().strip()).replace('str.', 'straße'))
to_xy = lambda lon, lat: ((lon - LON0) * KX, (lat - LAT0) * KY)

routes, platform_relations = {}, {}
for pbf in sys.argv[1:]:
    for relation in osmium.FileProcessor(pbf, osmium.osm.RELATION):
        tags = relation.tags
        if tags.get('type') == 'route' and tags.get('route') in ('subway', 'light_rail') and tags.get('network') == 'Verkehrsverbund Berlin-Brandenburg' and tags.get('ref') in lines:
            routes[relation.id] = (tags['ref'], [(m.type, m.ref, m.role) for m in relation.members])
        elif tags.get('public_transport') == 'platform':
            platform_relations[relation.id] = (dict(tags), [m.ref for m in relation.members if m.type == 'w' and m.role != 'inner'])

way_lines = {}
for line, members in routes.values():
    for kind, ref, role in members:
        if kind == 'w' and role == '':
            way_lines.setdefault(ref, set()).add(line)
route_ways = set(way_lines)
way_ids = {ref for _, members in routes.values() for kind, ref, _ in members if kind == 'w'}
way_ids |= {w for _, members in routes.values() for kind, ref, _ in members if kind == 'r' and ref in platform_relations for w in platform_relations[ref][1]}
node_ids = {ref for _, members in routes.values() for kind, ref, _ in members if kind == 'n'}

ways, nodes = {}, {}
for pbf in sys.argv[1:]:
    reader = osmium.FileProcessor(pbf).with_locations()
    reader = reader.with_filter(osmium.filter.IdFilter(node_ids).enable_for(osmium.osm.NODE))
    reader = reader.with_filter(osmium.filter.IdFilter(way_ids).enable_for(osmium.osm.WAY))
    for o in reader.with_filter(osmium.filter.EntityFilter(osmium.osm.NODE | osmium.osm.WAY)):
        try:
            if o.is_node():
                nodes[o.id] = (dict(o.tags), to_xy(o.location.lon, o.location.lat))
            else:
                ways[o.id] = (dict(o.tags), [n.ref for n in o.nodes], [to_xy(n.lon, n.lat) for n in o.nodes])
        except osmium.InvalidLocationError:
            pass

kinds = {}
for wid in route_ways & ways.keys():
    tags = ways[wid][0]
    layer = int((re.match(r'-?\d+', tags.get('layer', '0')) or ['0'])[0])
    if tags.get('tunnel', 'no') not in ('no', 'building_passage') or tags.get('location') == 'underground':
        kinds[wid] = ('tunnel', layer, None)
    elif tags.get('bridge', 'no') != 'no':
        kinds[wid] = ('bridge', layer, None)
    elif tags.get('cutting', 'no') != 'no':
        kinds[wid] = ('fixed', layer, CUTTING)
    elif tags.get('embankment', 'no') != 'no':
        kinds[wid] = ('fixed', layer, EMBANKMENT)
    else:
        kinds[wid] = ('up' if layer > 0 else 'down' if layer < 0 else 'fixed', layer, None if layer else 0)

grid = {}
for wid, (kind, layer, _) in kinds.items():
    pts = ways[wid][2]
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        length = math.hypot(x1 - x0, y1 - y0) or 1
        n = math.ceil(length / STEP)
        for k in range(n + 1):
            x, y = x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n
            grid.setdefault((int(x // NEAR), int(y // NEAR)), []).append((x, y, kind, layer, way_lines[wid], (x1 - x0) / length, (y1 - y0) / length))

relations = {}
for rid, (line, members) in routes.items():
    wl = [ref for kind, ref, role in members if kind == 'w' and role == '' and ref in ways]
    seq, edge_way = [], []
    for wid in wl:
        pair = list(zip(ways[wid][1], ways[wid][2]))
        if not seq:
            following = ways[wl[1]][1] if len(wl) > 1 else []
            seq = pair[::-1] if following and pair[0][0] in (following[0], following[-1]) else pair
            edge_way = [wid] * (len(pair) - 1)
            continue
        if seq[-1][0] == pair[-1][0]:
            pair.reverse()
        if seq[-1][0] == pair[0][0]:
            pair = pair[1:]
            edge_way += [wid] * len(pair)
        else:
            edge_way += [None] + [wid] * (len(pair) - 1)
        seq += pair
    if len(seq) < 2:
        continue
    xs, ys, ms, ws, vertex_m, m = [], [], [], [], [], 0
    for i in range(len(seq) - 1):
        (x0, y0), (x1, y1) = seq[i][1], seq[i + 1][1]
        length = math.hypot(x1 - x0, y1 - y0)
        vertex_m.append(m)
        n = max(1, math.ceil(length / STEP))
        for k in range(n):
            xs.append(x0 + (x1 - x0) * k / n)
            ys.append(y0 + (y1 - y0) * k / n)
            ms.append(m + length * k / n)
            ws.append(edge_way[i])
        m += length
    vertex_m.append(m)
    xs.append(seq[-1][1][0])
    ys.append(seq[-1][1][1])
    ms.append(m)
    ws.append(edge_way[-1])
    zs, soft, crosses = [], [], []
    for i, (x, y, wid) in enumerate(zip(xs, ys, ws)):
        kind, layer, z = kinds.get(wid, ('fixed', 0, 0))
        soft.append(kind)
        crosses.append(False)
        if kind not in ('tunnel', 'bridge'):
            zs.append(z)
            continue
        pick = min if kind == 'tunnel' else max
        ux, uy = xs[min(i + 1, len(xs) - 1)] - xs[max(i - 1, 0)], ys[min(i + 1, len(ys) - 1)] - ys[max(i - 1, 0)]
        near = [p for a in (-1, 0, 1) for b in (-1, 0, 1) for p in grid.get((int(x // NEAR) + a, int(y // NEAR) + b), ()) if math.hypot(p[0] - x, p[1] - y) < NEAR]
        own = pick([layer] + [p[3] for p in near if p[2] == kind and p[4] & way_lines[wid]])
        groups = {}
        for px, py, other_kind, other_layer, other_lines, vx, vy in near:
            if (kind, other_kind) != ('tunnel', 'bridge') and not other_lines & way_lines[wid] and abs(ux * vy - uy * vx) > 0.3 * math.hypot(ux, uy):
                key = (other_kind, frozenset(other_lines))
                groups[key] = pick(groups.get(key, other_layer), other_layer)
        beyond = {key: l for key, l in groups.items() if (l > own if kind == 'tunnel' else l < own)}
        count = len({l for (other_kind, _), l in beyond.items() if other_kind == kind})
        crosses[-1] = bool(beyond)
        zs.append(TUNNEL + TUNNEL_STEP * count if kind == 'tunnel' else BRIDGE + BRIDGE_STEP * count)
    start = 0
    for i in range(1, len(zs) + 1):
        if i == len(zs) or soft[i] != soft[start]:
            covered = soft[start] == 'tunnel' and 0 < start and i < len(zs) and all(soft[k] == 'down' or zs[k] == CUTTING for k in (start - 1, i))
            if soft[start] in ('tunnel', 'bridge') and (covered or ms[i - 1] - ms[start] < SHORT) and not any(crosses[start:i]):
                zs[start:i], soft[start:i] = [None] * (i - start), ['down' if covered else 'level'] * (i - start)
            start = i
    hard = [i for i, z in enumerate(zs) if z is not None]
    for i in range(len(zs)):
        if zs[i] is None:
            k = bisect_left(hard, i)
            before, after = hard[k - 1] if k else None, hard[k] if k < len(hard) else None
            if before is None or after is None:
                v = zs[before if after is None else after] if hard else 0
            else:
                v = zs[before] + (zs[after] - zs[before]) * (ms[i] - ms[before]) / (ms[after] - ms[before])
            zs[i] = max(v, EMBANKMENT) if soft[i] == 'up' else min(v, CUTTING) if soft[i] == 'down' else v
    stops, last = [], 0
    for kind, ref, role in members:
        if kind == 'n' and role.startswith('stop') and ref in nodes:
            stops.append({'node': ref, 'platform': None})
        elif role.startswith('platform'):
            if stops and stops[-1]['platform'] is None:
                stops[-1]['platform'] = (kind, ref)
            else:
                stops.append({'node': None, 'platform': (kind, ref)})
    route_nodes = [n for n, _ in seq]
    for stop in stops:
        kind, ref = stop['platform'] or ('n', stop['node'])
        node_tags = nodes[stop['node']][0] if stop['node'] in nodes else {}
        if kind == 'n':
            pts, tags = ([nodes[ref][1]], nodes[ref][0]) if ref in nodes else ([], {})
        else:
            outline = [ref] if kind == 'w' else platform_relations.get(ref, ({}, []))[1]
            pts = [p for w in outline if w in ways for p in ways[w][2]]
            tags = ways[ref][0] if kind == 'w' and ref in ways else platform_relations.get(ref, ({},))[0]
        stop['center'] = (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) if pts else None
        position = nodes[stop['node']][1] if stop['node'] in nodes else stop['center']
        track_tags, stop['m'] = {}, None
        if stop['node'] in route_nodes[last:]:
            last = route_nodes.index(stop['node'], last)
            stop['m'] = vertex_m[last]
            wid = edge_way[min(last, len(edge_way) - 1)]
            track_tags = ways[wid][0] if wid else {}
        elif position:
            stop['m'] = ms[min(range(bisect_left(ms, vertex_m[last]), len(ms)), key=lambda i: math.hypot(xs[i] - position[0], ys[i] - position[1]))]
        level = re.match(r'-?\d+', tags.get('level') or node_tags.get('level') or track_tags.get('level') or '')
        stop['level'] = int(level[0]) if level else None
        names = {norm(t.get('name', '')) for t in (tags, node_tags)} - {''}
        ifopt = by_ifopt.get((tags.get('ref:IFOPT', '').split(':') + ['', '', ''])[2])
        named = [s for s in lines[line]['stations'] if norm(stations[s]['name']) in names]
        distance = {s: math.dist(to_xy(stations[s]['lon'], stations[s]['lat']), position) for s in lines[line]['stations']} if position else {}
        nearest = min(distance, key=distance.get) if distance else None
        stop['station'] = ifopt if ifopt in lines[line]['stations'] else named[0] if named else nearest if nearest and distance[nearest] < 500 else None
    relations[rid] = {'line': line, 'xs': xs, 'ys': ys, 'ms': ms, 'zs': zs, 'ws': ws, 'stops': [s for s in stops if s['station'] and s['m'] is not None]}

half = lambda line: 55 if lines[line]['product'] == 'subway' else 70


def locate(rel, point, m0):
    window = range(bisect_left(rel['ms'], m0 - 400), bisect_right(rel['ms'], m0 + 400))
    return min(window, key=lambda i: math.hypot(rel['xs'][i] - point[0], rel['ys'][i] - point[1]))


platform_data = {}
for rel in relations.values():
    for stop in rel['stops']:
        center = stop['center'] or nodes[stop['node']][1]
        data = platform_data.setdefault((stop['station'], stop['platform'] or stop['node']), {'level': stop['level'], 'lines': set(), 'points': set(), 'z': []})
        i = locate(rel, center, stop['m'])
        window = [rel['zs'][k] for k in range(bisect_left(rel['ms'], rel['ms'][i] - half(rel['line'])), bisect_right(rel['ms'], rel['ms'][i] + half(rel['line'])))]
        data['lines'].add(rel['line'])
        data['points'].add((round(rel['xs'][i]), round(rel['ys'][i])))
        data['z'].append(min(window) if rel['zs'][i] < 0 else max(window) if rel['zs'][i] > 0 else 0)
for data in platform_data.values():
    data['center'] = (sum(p[0] for p in data['points']) / len(data['points']), sum(p[1] for p in data['points']) / len(data['points']))
    data['z'] = sum(data['z']) / len(data['z'])
for station in stations:
    group = [data for (s, _), data in platform_data.items() if s == station]
    for sign, base, step in ((-1, TUNNEL, TUNNEL_STEP), (1, BRIDGE, BRIDGE_STEP)):
        stacked = [data for data in group if data['level'] is not None and data['z'] * sign >= abs(base) - 1]
        levels = sorted({data['level'] for data in stacked}, key=lambda level: level * sign)
        if len(levels) > 1 and len(set().union(*(data['lines'] for data in stacked))) > 1:
            for data in stacked:
                data['z'] = base + step * levels.index(data['level'])

platforms, platform_z = {}, {}
for line in lines:
    for station in lines[line]['stations']:
        group = [data for (s, _), data in platform_data.items() if s == station and line in data['lines']]
        centers = [data['center'] for data in group] or [to_xy(stations[station]['lon'], stations[station]['lat'])]
        platforms.setdefault(station, {})[line] = (sum(c[0] for c in centers) / len(centers), sum(c[1] for c in centers) / len(centers))
        platform_z.setdefault(station, {})[line] = KNOWN.get((stations[station]['name'], line), sum(data['z'] for data in group) / len(group) if group else 0)


def envelope(values, s, sign, grade):
    out = list(values)
    for i, j in [(i, i - 1) for i in range(1, len(out))] + [(i, i + 1) for i in range(len(out) - 2, -1, -1)]:
        if out[j] is not None:
            v = out[j] - sign * grade * abs(s[i] - s[j])
            out[i] = v if out[i] is None else max(out[i], v) if sign > 0 else min(out[i], v)
    return out


def simplify(pts, forced):
    keep = sorted({0, len(pts) - 1} | forced)
    stack = list(zip(keep, keep[1:]))
    keep = set(keep)
    while stack:
        a, b = stack.pop()
        (ax, ay, az), (bx, by, bz) = pts[a], pts[b]
        dx, dy, dz = bx - ax, by - ay, (bz - az) * 8
        length = dx * dx + dy * dy + dz * dz or 1
        best, index = 0, None
        for i in range(a + 1, b):
            px, py, pz = pts[i][0] - ax, pts[i][1] - ay, (pts[i][2] - az) * 8
            t = max(0, min(1, (px * dx + py * dy + pz * dz) / length))
            d = math.hypot(px - t * dx, py - t * dy, pz - t * dz)
            if d > best:
                best, index = d, i
        if best > TOLERANCE:
            keep.add(index)
            stack += [(a, index), (index, b)]
    return sorted(keep)


def bend(seg, at, target, sign, width):
    s, z, half = seg['s'], seg['z'], seg['half']
    target = sign * min([sign * target] + [sign * zi + GRADE * max(0, abs(si - at) - width) for si, zi in zip(s, z) if si <= half or si >= s[-1] - half])
    seg['z'] = [sign * max(sign * zi, sign * target - GRADE * max(0, abs(si - at) - width)) for si, zi in zip(s, z)]


def layer(x, y, group):
    near = [p for a in (-1, 0, 1) for b in (-1, 0, 1) for p in grid.get((int(x // NEAR) + a, int(y // NEAR) + b), ()) if p[4] & group]
    return min(near, key=lambda p: math.hypot(p[0] - x, p[1] - y))[3] if near else 0


built, fallbacks = [], []
for segment in network['segments']:
    start, end = segment['from'], segment['to']
    groups = []
    for line in segment['lines']:
        match = next((group for group in groups if all(math.dist(platforms[s][group[0]], platforms[s][line]) < 30 and abs(platform_z[s][group[0]] - platform_z[s][line]) < 2 for s in (start, end))), None)
        if match:
            match.append(line)
        else:
            groups.append([line])
    for group in groups:
        first = group[0]
        p0, p1 = platforms[start][first], platforms[end][first]
        z0, z1 = platform_z[start][first], platform_z[end][first]
        paths = {}
        for line in group:
            for rel in relations.values():
                if rel['line'] != line:
                    continue
                a = [s for s in rel['stops'] if s['station'] == start]
                b = [s for s in rel['stops'] if s['station'] == end]
                if not a or not b:
                    continue
                sa, sb = min(((sa, sb) for sa in a for sb in b), key=lambda p: abs(p[0]['m'] - p[1]['m']))
                i, j = locate(rel, p0, sa['m']), locate(rel, p1, sb['m'])
                if i == j or None in rel['ws'][min(i, j):max(i, j)]:
                    continue
                path = [(rel['xs'][k], rel['ys'][k], rel['zs'][k]) for k in (range(i, j + 1) if i < j else range(i, j - 1, -1))]
                paths.setdefault(i < j, path)
        if not paths:
            hafas, center = [p0] + [to_xy(*c) for c in segment['coords'][1:-1]] + [p1], []
            for (x0, y0), (x1, y1) in zip(hafas, hafas[1:]):
                n = max(1, math.ceil(math.hypot(x1 - x0, y1 - y0) / STEP))
                center += [(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n) for k in range(n)]
            center = [(x, y, z0 + (z1 - z0) * k / len(center)) for k, (x, y) in enumerate(center + [p1])]
            fallbacks.append(f"{stations[start]['name']} - {stations[end]['name']} {'/'.join(group)}")
        else:
            a = paths.get(True) or paths[False]
            b = paths.get(False) if True in paths else None
            center, j = [], 0
            for x, y, z in a:
                if b:
                    j = min(range(max(0, j - 2), min(len(b), j + 40)), key=lambda k: math.hypot(b[k][0] - x, b[k][1] - y))
                    center.append(((x + b[j][0]) / 2, (y + b[j][1]) / 2, (z + b[j][2]) / 2))
                else:
                    center.append((x, y, z))
        s = [0]
        for (x0, y0, _), (x1, y1, _) in zip(center, center[1:]):
            s.append(s[-1] + math.hypot(x1 - x0, y1 - y0))
        blend, moved = min(60, s[-1] / 2) or 1, []
        (ax, ay, _), (bx, by, _) = center[0], center[-1]
        for (x, y, z), d in zip(center, s):
            w0, w1 = max(0, 1 - d / blend), max(0, 1 - (s[-1] - d) / blend)
            moved.append((x + (p0[0] - ax) * w0 + (p1[0] - bx) * w1, y + (p0[1] - ay) * w0 + (p1[1] - by) * w1, z))
        center = moved
        grade = max(GRADE, abs(z1 - z0) / max(s[-1] - 2 * half(first), 1))
        fixed = [z0 if d <= half(first) else z1 if s[-1] - d <= half(first) else None for d in s]
        low, high = envelope(fixed, s, 1, grade), envelope(fixed, s, -1, grade)
        raw = []
        for (_, _, z), d in zip(center, s):
            between = z0 + (z1 - z0) * d / s[-1]
            raw.append(min(z, between) if z <= TUNNEL else max(z, between) if z >= BRIDGE else z)
        neg, pos = envelope([min(z, 0) for z in raw], s, -1, grade), envelope([max(z, 0) for z in raw], s, 1, grade)
        zs = [min(max(n + p, lo), hi) for n, p, lo, hi in zip(neg, pos, low, high)]
        forward, backward = list(zs), list(zs)
        for i in range(1, len(zs)):
            d = grade * (s[i] - s[i - 1])
            forward[i] = min(max(forward[i], forward[i - 1] - d), forward[i - 1] + d)
        for i in range(len(zs) - 2, -1, -1):
            d = grade * (s[i + 1] - s[i])
            backward[i] = min(max(backward[i], backward[i + 1] - d), backward[i + 1] + d)
        zs = [(a + b) / 2 for a, b in zip(forward, backward)]
        built.append({'from': start, 'to': end, 'lines': group, 'group': set(group), 'half': half(first), 'xy': [(x, y) for x, y, _ in center], 's': s, 'z': zs})

for A in built:
    for B in built:
        for station in set() if A['group'] & B['group'] else {A['from'], A['to']} & {B['from'], B['to']}:
            za, zb = platform_z[station][A['lines'][0]], platform_z[station][B['lines'][0]]
            if za >= ROOF or za - zb < 2:
                continue
            ends = (0 if A['from'] == station else A['s'][-1], 0 if B['from'] == station else B['s'][-1])
            stacked = [(si, sj, gap) for (x, y), si in zip(A['xy'], A['s']) if abs(si - ends[0]) < STACK for (u, v), sj in zip(B['xy'], B['s']) if abs(sj - ends[1]) < STACK and (gap := math.hypot(u - x, v - y)) < NEAR]
            for si, _, _ in stacked:
                bend(A, si, za, 1, 0)
            for si, sj, gap in stacked:
                if gap < NEAR / 4:
                    bend(B, sj, A['z'][bisect_left(A['s'], si)] - CLEAR, -1, 0)

cells = {}
for a, seg in enumerate(built):
    for i in range(1, len(seg['xy'])):
        for x, y in seg['xy'][i - 1:i + 1]:
            cells.setdefault((int(x // 50), int(y // 50)), set()).add((a, i))
crossings = {}
for edges in cells.values():
    for a, i in edges:
        for b, j in edges:
            A, B = built[a], built[b]
            if a >= b or A['group'] & B['group']:
                continue
            (x1, y1), (x2, y2), (x3, y3), (x4, y4) = A['xy'][i - 1], A['xy'][i], B['xy'][j - 1], B['xy'][j]
            d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3)
            if not d:
                continue
            t, u = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d, ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d
            sine = abs(d) / (math.hypot(x2 - x1, y2 - y1) * math.hypot(x4 - x3, y4 - y3) or 1)
            if 0 <= t < 1 and 0 <= u < 1 and sine > 0.14:
                crossings[(a, i, b, j)] = (t, u, sine, x1 + (x2 - x1) * t, y1 + (y2 - y1) * t)
height = lambda seg, i, t: seg['z'][i - 1] + (seg['z'][i] - seg['z'][i - 1]) * t
separated = []
for (a, i, b, j), (t, u, sine, x, y) in crossings.items():
    A, B = built[a], built[b]
    za, zb = height(A, i, t), height(B, j, u)
    la, lb = layer(x, y, A['group']), layer(x, y, B['group'])
    if abs(za - zb) > NARROW or max(za, zb) > 3 or min(za, zb) > -2 and (la == lb or (la > lb) == (za > zb)):
        continue
    low = la < lb if la != lb else za < zb if abs(za - zb) >= 0.5 else lines[A['lines'][0]]['product'] == 'suburban'
    (L, li, lt), (U, ui, ut) = ((A, i, t), (B, j, u)) if low else ((B, j, u), (A, i, t))
    width = min(60, 8 / sine)
    upper = height(U, ui, ut)
    bend(L, L['s'][li - 1] + (L['s'][li] - L['s'][li - 1]) * lt, max(upper - CLEAR, CUTTING) if height(L, li, lt) > ROOF else upper - CLEAR, -1, width)
    bend(U, U['s'][ui - 1] + (U['s'][ui] - U['s'][ui - 1]) * ut, min(height(L, li, lt) + CLEAR, BRIDGE if max(la, lb) > 0 else max(upper, ROOF - 0.5)), 1, width)
    if height(U, ui, ut) - height(L, li, lt) > abs(za - zb) + 0.1:
        separated.append(f"{stations[L['from']]['name']} - {stations[L['to']]['name']} {'/'.join(L['lines'])} under {'/'.join(U['lines'])}: {abs(za - zb):.1f} m -> {height(U, ui, ut) - height(L, li, lt):.1f} m")

cells = {}
for a, seg in enumerate(built):
    for i in range(1, len(seg['xy'])):
        for x, y in seg['xy'][i - 1:i + 1]:
            cells.setdefault((int(x // 10), int(y // 10)), set()).add((a, i))
for a, seg in enumerate(built):
    seg['near'] = []
    for (x, y), z in zip(seg['xy'], seg['z']):
        found = {}
        for b, j in {edge for gx in (-1, 0, 1) for gy in (-1, 0, 1) for edge in cells.get((int(x // 10) + gx, int(y // 10) + gy), ())}:
            other = built[b]
            if b in found or seg['group'] & other['group']:
                continue
            (x0, y0), (x1, y1) = other['xy'][j - 1], other['xy'][j]
            dx, dy = x1 - x0, y1 - y0
            t = max(0, min(1, ((x - x0) * dx + (y - y0) * dy) / (dx * dx + dy * dy or 1)))
            if math.hypot(x0 + dx * t - x, y0 + dy * t - y) < SHARED and abs(height(other, j, t) - z) < 2:
                found[b] = j
        seg['near'].append(found)
for a, seg in enumerate(built):
    xy, s, shift = seg['xy'], seg['s'], [0] * len(seg['xy'])
    for b in {b for found in seg['near'] for b in found}:
        other, on = built[b], [b in found for found in seg['near']]
        runs, start = [], None
        for i in range(len(on) + 1):
            if i < len(on) and on[i] and start is None:
                start = i
            elif (i == len(on) or not on[i]) and start is not None:
                if runs and s[start] - s[runs[-1][1]] < 30:
                    runs[-1][1] = i - 1
                else:
                    runs.append([start, i - 1])
                start = None
        runs = [run for run in runs if s[run[1]] - s[run[0]] >= 30]
        if not runs:
            continue
        votes, inside = 0, 0
        for i0, i1 in runs:
            for direction, edge in ((-1, i0), (1, i1)):
                j, k = seg['near'][edge][b], edge
                window = other['xy'][max(0, j - 80):j + 80]
                while 0 < k < len(xy) - 1 and abs(s[k] - s[edge]) < 300:
                    qx, qy = min(window, key=lambda q: math.hypot(q[0] - xy[k][0], q[1] - xy[k][1]))
                    if math.hypot(qx - xy[k][0], qy - xy[k][1]) > 8:
                        votes += math.copysign(1, (xy[k + 1][0] - xy[k - 1][0]) * (qy - xy[k][1]) - (xy[k + 1][1] - xy[k - 1][1]) * (qx - xy[k][0]))
                        break
                    k += direction
            for k in range(max(i0, 1), min(i1, len(xy) - 2) + 1):
                if b in seg['near'][k]:
                    qx, qy = other['xy'][seg['near'][k][b]]
                    inside += (xy[k + 1][0] - xy[k - 1][0]) * (qy - xy[k][1]) - (xy[k + 1][1] - xy[k - 1][1]) * (qx - xy[k][0])
        side = math.copysign(1, votes or inside or (b - a))
        ends = {other['from'], other['to']}
        covered = {i for i0, i1 in runs for i in range(0 if seg['from'] in ends and s[i0] < 120 else i0, len(s) if seg['to'] in ends and s[-1] - s[i1] < 120 else i1 + 1)}
        for i in covered:
            shift[i] += side * len(other['lines']) / 2
    windows = [(bisect_left(s, d - RAMP), bisect_right(s, d + RAMP)) for d in s]
    seg['shift'] = [sum(shift[lo:hi]) / (hi - lo) for lo, hi in windows] if any(shift) else shift

segments = []
for seg in built:
    shift = seg['shift']
    keep = simplify([(x, y, z) for (x, y), z in zip(seg['xy'], seg['z'])], {i for i in range(1, len(shift)) if abs(shift[i] - shift[i - 1]) > 0.005})
    segments.append({'from': seg['from'], 'to': seg['to'], 'lines': seg['lines'], 'coords': [[round(seg['xy'][i][0] / KX + LON0, 6), round(seg['xy'][i][1] / KY + LAT0, 6), round(seg['z'][i], 1)] for i in keep]})
    if any(abs(shift[i]) > 0.01 for i in keep):
        segments[-1]['shift'] = [round(shift[i], 2) for i in keep]

output = {
    'source': 'OpenStreetMap (ODbL), © OpenStreetMap contributors; heights from tunnel, bridge, layer, level, cutting and embankment tags, some station heights from BVG and Wikipedia',
    'segments': segments,
    'platforms': {station: {line: [round(x / KX + LON0, 6), round(y / KY + LAT0, 6), round(platform_z[station][line], 1)] for line, (x, y) in by_line.items()} for station, by_line in platforms.items()},
}
(ROOT / 'public/data/tracks3d.json').write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':')))
print(f'{len(segments) - len(fallbacks)} segments from OpenStreetMap, {len(fallbacks)} fallbacks, {sum("shift" in segment for segment in segments)} shifted beside shared track')
for fallback in fallbacks:
    print('fallback:', fallback)
for line in separated:
    print('crossing:', line)
