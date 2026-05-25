// floorplan.js — 2D editor and 3D dollhouse viewer for the home layout.
// Internal coordinate unit: 1 unit = 40 SVG pixels = 1 Three.js world unit.

import * as THREE     from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const UNIT_PX      = 40;
const SCENE_W      = 800;
const SCENE_H      = 540;
const WALL_HEIGHT  = 1.5;
const WALL_THICK   = 0.12;
const ROOM_FLOOR_Y = 0;

export class Floorplan {
  constructor({
    container3D, container2D, canvas3D, svg2D, tooltip3D,
    getRooms, getDeviceCountForRoom, isRoomActive,
    onRoomTap, onRoomEdit, onLayoutChange,
  }) {
    this.container3D = container3D;
    this.container2D = container2D;
    this.canvas3D = canvas3D;
    this.svg2D = svg2D;
    this.tooltip3D = tooltip3D;
    this.getRooms = getRooms;
    this.getDeviceCountForRoom = getDeviceCountForRoom;
    this.isRoomActive = isRoomActive;
    this.onRoomTap = onRoomTap;
    this.onRoomEdit = onRoomEdit;
    this.onLayoutChange = onLayoutChange;

    this.mode = 'view';          // 'view' (3D) | 'edit' (2D)
    this.theme = 'light';
    this.selectedRoomId = null;

    // 2D editor state
    this.dragState = null;       // { roomId, mode: 'move'|'resize-tl/tr/bl/br', start... }
    this.layout = new Map();     // roomId -> { x, y, width, height } (pending changes)

    this._init3D();
    this._init2D();

    window.addEventListener('resize', () => this._resize3D());
  }

  setMode(mode) {
    this.mode = mode;
    if (mode === 'view') {
      this.container3D.style.display = '';
      this.container2D.style.display = 'none';
      this._resize3D();
      this.refresh();
    } else {
      this.container3D.style.display = 'none';
      this.container2D.style.display = '';
      this.refresh();
    }
  }

  setTheme(theme) {
    this.theme = theme;
    this._applySceneTheme();
    this.refresh();
  }

  refresh() {
    // Rebuild 3D scene from rooms
    this._rebuild3D();
    // Rebuild 2D editor
    this._rebuild2D();
  }

  // Returns array of rooms with changed floor_plan since last clearDirty()
  getDirtyRooms() {
    const dirty = [];
    for (const [roomId, layout] of this.layout) {
      dirty.push({ roomId, floor_plan: layout });
    }
    return dirty;
  }

  clearDirty() { this.layout.clear(); }

  // Auto-place a brand-new room that has no floor_plan yet.
  // Finds an open spot in a 3-wide grid and returns { x, y, width, height }.
  autoPlace() {
    const all = this._getAllPlacements();
    const W = 4, H = 3, COLS = 3, GAP = 0.5;
    for (let row = 0; row < 20; row++) {
      for (let col = 0; col < COLS; col++) {
        const x = col * (W + GAP);
        const y = row * (H + GAP);
        const overlaps = all.some(p =>
          x < p.x + p.width  && x + W > p.x &&
          y < p.y + p.height && y + H > p.y);
        if (!overlaps) return { x, y, width: W, height: H };
      }
    }
    return { x: 0, y: 0, width: W, height: H };
  }

  _getAllPlacements() {
    const out = [];
    for (const r of this.getRooms().values()) {
      const fp = this.layout.get(r.room_id) || r.floor_plan;
      if (fp) out.push(fp);
    }
    return out;
  }

  // =============================================================
  // 3D — Three.js dollhouse
  // =============================================================
  _init3D() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas3D, antialias: true, alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));

    this.scene = new THREE.Scene();
    this._applySceneTheme();

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
    this.camera.position.set(8, 12, 12);
    this.camera.lookAt(4, 0, 4);

    this.controls = new OrbitControls(this.camera, this.canvas3D);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 40;
    this.controls.maxPolarAngle = Math.PI / 2.2;
    this.controls.target.set(4, 0, 4);

    // lights
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(10, 18, 8);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xb4c7ff, 0.25);
    fill.position.set(-8, 6, -8);
    this.scene.add(fill);

    this.roomGroup = new THREE.Group();
    this.scene.add(this.roomGroup);

    // Raycaster for tap-to-drill-in
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDownAt = null;

    this.canvas3D.addEventListener('pointerdown', (e) => {
      this.pointerDownAt = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    this.canvas3D.addEventListener('pointermove', (e) => this._onHover3D(e));
    this.canvas3D.addEventListener('pointerleave', () => this._hideTooltip());
    this.canvas3D.addEventListener('pointerup', (e) => {
      if (!this.pointerDownAt) return;
      const dx = e.clientX - this.pointerDownAt.x;
      const dy = e.clientY - this.pointerDownAt.y;
      const dt = Date.now() - this.pointerDownAt.t;
      this.pointerDownAt = null;
      // Treat as tap only if minimal movement
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6 && dt < 400) this._onTap3D(e);
    });

    this._animate();
  }

  _resize3D() {
    if (this.mode !== 'view') return;
    const rect = this.container3D.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _animate() {
    requestAnimationFrame(() => this._animate());
    if (this.mode === 'view') {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    }
  }

  _applySceneTheme() {
    // Read CSS variables resolved on the current document
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--scene-bg').trim() || '#e8edf5';
    this.scene.background = new THREE.Color(bg);
  }

  _rebuild3D() {
    // Clear previous rooms
    while (this.roomGroup.children.length) {
      const c = this.roomGroup.children[0];
      this.roomGroup.remove(c);
      c.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          if (Array.isArray(o.material)) o.material.forEach(m => m.dispose());
          else o.material.dispose();
        }
      });
    }
    const cs = getComputedStyle(document.documentElement);
    const floorColor   = new THREE.Color(cs.getPropertyValue('--scene-floor').trim() || '#fff');
    const wallColor    = new THREE.Color(cs.getPropertyValue('--scene-wall').trim()  || '#d0d8e8');
    const activeColor  = new THREE.Color(cs.getPropertyValue('--scene-room-on').trim() || '#3b82f6');

    const rooms = [...this.getRooms().values()];
    let bbox = null;
    for (const room of rooms) {
      const fp = this.layout.get(room.room_id) || room.floor_plan;
      if (!fp) continue;
      const isActive = this.isRoomActive ? this.isRoomActive(room.room_id) : false;
      const group = this._buildRoomMesh(room, fp, {
        floorColor: isActive ? activeColor : floorColor,
        wallColor, isActive,
      });
      group.userData.roomId = room.room_id;
      this.roomGroup.add(group);
      if (!bbox) bbox = { minX: fp.x, minZ: fp.y, maxX: fp.x + fp.width, maxZ: fp.y + fp.height };
      else {
        bbox.minX = Math.min(bbox.minX, fp.x);
        bbox.minZ = Math.min(bbox.minZ, fp.y);
        bbox.maxX = Math.max(bbox.maxX, fp.x + fp.width);
        bbox.maxZ = Math.max(bbox.maxZ, fp.y + fp.height);
      }
    }

    // Adjust camera target to center of bounding box
    if (bbox) {
      const cx = (bbox.minX + bbox.maxX) / 2;
      const cz = (bbox.minZ + bbox.maxZ) / 2;
      this.controls.target.set(cx, 0, cz);
      // Distance scales with home size
      const size = Math.max(bbox.maxX - bbox.minX, bbox.maxZ - bbox.minZ);
      const dist = Math.max(8, size * 1.4);
      this.camera.position.set(cx + dist * 0.6, dist * 0.9, cz + dist * 0.6);
    }

    // Toggle empty state overlay
    const emptyEl = document.getElementById('floorplan-3d-empty');
    if (emptyEl) emptyEl.style.display = (rooms.filter(r => r.floor_plan).length === 0) ? '' : 'none';
  }

  _buildRoomMesh(room, fp, { floorColor, wallColor, isActive }) {
    const g = new THREE.Group();
    const w = fp.width, d = fp.height, x = fp.x, z = fp.y;

    // Floor
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(w, 0.05, d),
      new THREE.MeshLambertMaterial({ color: floorColor })
    );
    floor.position.set(x + w / 2, ROOM_FLOOR_Y, z + d / 2);
    floor.userData.isFloor = true;
    g.add(floor);

    // 4 walls (thin boxes)
    const wallMat = new THREE.MeshLambertMaterial({ color: wallColor });
    const halfH = WALL_HEIGHT / 2;
    const wallN = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_HEIGHT, WALL_THICK), wallMat);
    wallN.position.set(x + w / 2, halfH, z);
    g.add(wallN);
    const wallS = new THREE.Mesh(new THREE.BoxGeometry(w, WALL_HEIGHT, WALL_THICK), wallMat);
    wallS.position.set(x + w / 2, halfH, z + d);
    g.add(wallS);
    const wallW = new THREE.Mesh(new THREE.BoxGeometry(WALL_THICK, WALL_HEIGHT, d), wallMat);
    wallW.position.set(x, halfH, z + d / 2);
    g.add(wallW);
    const wallE = new THREE.Mesh(new THREE.BoxGeometry(WALL_THICK, WALL_HEIGHT, d), wallMat);
    wallE.position.set(x + w, halfH, z + d / 2);
    g.add(wallE);

    // Floating label sprite (icon + name)
    const sprite = this._buildLabelSprite(room);
    sprite.position.set(x + w / 2, WALL_HEIGHT + 0.4, z + d / 2);
    g.add(sprite);

    return g;
  }

  _buildLabelSprite(room) {
    // Render text to a canvas, use as a sprite texture so it always faces camera
    const canvas = document.createElement('canvas');
    const dpr = 2;
    canvas.width = 256 * dpr; canvas.height = 96 * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font = '600 14px "Plus Jakarta Sans", sans-serif';
    const cs = getComputedStyle(document.documentElement);
    const fg = cs.getPropertyValue('--ink').trim() || '#0f172a';
    const bg = cs.getPropertyValue('--card').trim() || '#fff';
    const stroke = cs.getPropertyValue('--line').trim() || '#e5e7eb';

    const text = `${room.icon || '🚪'}  ${room.name}`;
    const tw = ctx.measureText(text).width;
    const padX = 14, padY = 8;
    const boxW = tw + padX * 2;
    const boxH = 28;
    const boxX = (256 - boxW) / 2;
    const boxY = 96 / 2 - boxH / 2;
    // rounded rect bg
    ctx.fillStyle = bg;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    this._roundRect(ctx, boxX, boxY, boxW, boxH, 10);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, boxX + padX, boxY + boxH / 2 + 1);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.6, 0.6, 1);
    sprite.userData.isLabel = true;
    return sprite;
  }
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  _onTap3D(e) {
    const hit = this._pickRoom(e);
    if (hit) this.onRoomTap?.(hit);
  }
  _onHover3D(e) {
    const hit = this._pickRoom(e);
    if (hit) {
      const rooms = this.getRooms();
      const room = rooms.get(hit);
      if (room) {
        const count = this.getDeviceCountForRoom?.(hit) || 0;
        const tt = this.tooltip3D;
        tt.style.display = '';
        tt.style.opacity = '1';
        tt.style.left = `${e.offsetX}px`;
        tt.style.top = `${e.offsetY}px`;
        tt.textContent = `${room.icon || '🚪'} ${room.name} — ${count} appliance${count === 1 ? '' : 's'}`;
        this.canvas3D.style.cursor = 'pointer';
        return;
      }
    }
    this._hideTooltip();
    this.canvas3D.style.cursor = '';
  }
  _hideTooltip() {
    if (this.tooltip3D) this.tooltip3D.style.opacity = '0';
  }
  _pickRoom(e) {
    const rect = this.canvas3D.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
    this.pointer.y = ((e.clientY - rect.top)  / rect.height) * -2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.roomGroup.children, true);
    for (const i of intersects) {
      let n = i.object;
      while (n && !n.userData.roomId) n = n.parent;
      if (n) return n.userData.roomId;
    }
    return null;
  }

  // =============================================================
  // 2D — SVG editor
  // =============================================================
  _init2D() {
    this.svg2D.addEventListener('pointerdown', (e) => this._onSvgPointerDown(e));
    this.svg2D.addEventListener('pointermove', (e) => this._onSvgPointerMove(e));
    this.svg2D.addEventListener('pointerup',   (e) => this._onSvgPointerUp(e));
    this.svg2D.addEventListener('pointerleave',(e) => this._onSvgPointerUp(e));
  }

  _rebuild2D() {
    while (this.svg2D.firstChild) this.svg2D.removeChild(this.svg2D.firstChild);
    const rooms = [...this.getRooms().values()];
    for (const room of rooms) {
      const fp = this.layout.get(room.room_id) || room.floor_plan;
      if (!fp) continue;
      this._draw2DRoom(room, fp);
    }
  }

  _draw2DRoom(room, fp) {
    const ns = 'http://www.w3.org/2000/svg';
    const x = fp.x * UNIT_PX, y = fp.y * UNIT_PX;
    const w = fp.width * UNIT_PX, h = fp.height * UNIT_PX;

    const g = document.createElementNS(ns, 'g');
    g.dataset.roomId = room.room_id;
    g.setAttribute('transform', `translate(${x},${y})`);

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', 0);
    rect.setAttribute('width', w);
    rect.setAttribute('height', h);
    rect.setAttribute('rx', 6);
    rect.classList.add('fp-edit-room');
    if (this.selectedRoomId === room.room_id) rect.classList.add('selected');
    rect.dataset.roomId = room.room_id;
    rect.dataset.action = 'move';
    g.appendChild(rect);

    // Icon and label inside
    const icon = document.createElementNS(ns, 'text');
    icon.setAttribute('x', w / 2);
    icon.setAttribute('y', h / 2 - 6);
    icon.setAttribute('text-anchor', 'middle');
    icon.classList.add('fp-room-icon');
    icon.textContent = room.icon || '🚪';
    g.appendChild(icon);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', w / 2);
    label.setAttribute('y', h / 2 + 18);
    label.setAttribute('text-anchor', 'middle');
    label.classList.add('fp-room-label');
    label.textContent = room.name;
    g.appendChild(label);

    // Resize handles (only when selected)
    if (this.selectedRoomId === room.room_id) {
      const handles = [
        { x: 0, y: 0, action: 'resize-tl' },
        { x: w, y: 0, action: 'resize-tr' },
        { x: 0, y: h, action: 'resize-bl' },
        { x: w, y: h, action: 'resize-br' },
      ];
      for (const h of handles) {
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', h.x); c.setAttribute('cy', h.y);
        c.setAttribute('r', 7);
        c.classList.add('fp-handle');
        c.dataset.roomId = room.room_id;
        c.dataset.action = h.action;
        g.appendChild(c);
      }
    }

    this.svg2D.appendChild(g);
  }

  _svgPoint(e) {
    const pt = this.svg2D.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = this.svg2D.getScreenCTM().inverse();
    return pt.matrixTransform(ctm);
  }

  _onSvgPointerDown(e) {
    const target = e.target.closest('[data-action]');
    const roomId = target?.dataset.roomId;
    const action = target?.dataset.action;
    if (!target) {
      // clicked empty area → deselect
      this.selectedRoomId = null;
      this._notifySelection();
      this._rebuild2D();
      return;
    }
    e.preventDefault();
    this.selectedRoomId = roomId;
    this._notifySelection();

    const pt = this._svgPoint(e);
    const room = this.getRooms().get(roomId);
    const fp = this.layout.get(roomId) || { ...room.floor_plan };
    this.dragState = {
      roomId, action,
      startPt: pt,
      startFp: { ...fp },
    };
    this.svg2D.setPointerCapture(e.pointerId);
    this._rebuild2D();
  }

  _onSvgPointerMove(e) {
    if (!this.dragState) return;
    e.preventDefault();
    const pt = this._svgPoint(e);
    const dx = (pt.x - this.dragState.startPt.x) / UNIT_PX;
    const dy = (pt.y - this.dragState.startPt.y) / UNIT_PX;
    const startFp = this.dragState.startFp;
    let nfp;
    const minSize = 1.5;
    if (this.dragState.action === 'move') {
      nfp = { x: startFp.x + dx, y: startFp.y + dy, width: startFp.width, height: startFp.height };
      nfp.x = Math.max(0, nfp.x);
      nfp.y = Math.max(0, nfp.y);
    } else if (this.dragState.action === 'resize-br') {
      nfp = { x: startFp.x, y: startFp.y,
              width:  Math.max(minSize, startFp.width + dx),
              height: Math.max(minSize, startFp.height + dy) };
    } else if (this.dragState.action === 'resize-bl') {
      const nx = Math.min(startFp.x + dx, startFp.x + startFp.width - minSize);
      nfp = { x: nx, y: startFp.y,
              width:  startFp.width + (startFp.x - nx),
              height: Math.max(minSize, startFp.height + dy) };
    } else if (this.dragState.action === 'resize-tr') {
      const ny = Math.min(startFp.y + dy, startFp.y + startFp.height - minSize);
      nfp = { x: startFp.x, y: ny,
              width:  Math.max(minSize, startFp.width + dx),
              height: startFp.height + (startFp.y - ny) };
    } else if (this.dragState.action === 'resize-tl') {
      const nx = Math.min(startFp.x + dx, startFp.x + startFp.width - minSize);
      const ny = Math.min(startFp.y + dy, startFp.y + startFp.height - minSize);
      nfp = { x: nx, y: ny,
              width:  startFp.width + (startFp.x - nx),
              height: startFp.height + (startFp.y - ny) };
    }
    // Snap to half-unit grid
    nfp.x      = Math.round(nfp.x      * 2) / 2;
    nfp.y      = Math.round(nfp.y      * 2) / 2;
    nfp.width  = Math.round(nfp.width  * 2) / 2;
    nfp.height = Math.round(nfp.height * 2) / 2;
    this.layout.set(this.dragState.roomId, nfp);
    this._rebuild2D();
  }

  _onSvgPointerUp(e) {
    if (!this.dragState) return;
    this.svg2D.releasePointerCapture(e.pointerId);
    const wasDragging = this.dragState;
    this.dragState = null;
    // Commit: notify app to persist
    if (wasDragging) this.onLayoutChange?.();
  }

  _notifySelection() {
    // Visible by app to toggle "edit/delete selected" toolbar buttons
    document.getElementById('edit-selected-room').style.display    = this.selectedRoomId ? '' : 'none';
    document.getElementById('delete-selected-room').style.display  = this.selectedRoomId ? '' : 'none';
  }

  getSelectedRoomId() { return this.selectedRoomId; }
  selectRoom(id) { this.selectedRoomId = id; this._rebuild2D(); this._notifySelection(); }
  clearSelection() { this.selectedRoomId = null; this._rebuild2D(); this._notifySelection(); }
}
