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

// Room labels are scaled by their distance to the camera every frame so they
// stay a constant (large, readable) size on screen at any zoom level. Bigger
// number = bigger labels. The value is height-in-world per unit of distance.
const LABEL_SCREEN_K = 0.115;

// One cohesive material for the whole home — no per-room tinting. Rooms read as
// a single clean architectural model; the only colour comes from the accent
// glow on an active room. Floors sit a touch darker than walls for interior
// depth. Light theme = soft neutral paper; dark theme = refined slate.
const ROOM_PALETTE_LIGHT = { wall: '#e4e9f0', floor: '#f3f5f9' };
const ROOM_PALETTE_DARK  = { wall: '#333b4f', floor: '#222a3a' };
// Corridors share the room tone so the house reads as one continuous structure.
const CORRIDOR_PALETTE_LIGHT = ROOM_PALETTE_LIGHT;
const CORRIDOR_PALETTE_DARK  = ROOM_PALETTE_DARK;

function paletteForRoom(_room, isDark) {
  return isDark ? ROOM_PALETTE_DARK : ROOM_PALETTE_LIGHT;
}

export class Floorplan {
  constructor({
    container3D, container2D, canvas3D, svg2D, tooltip3D,
    getRooms, getDeviceCountForRoom, isRoomActive,
    getAppliancesForRoom,
    onRoomTap, onApplianceTap, onRoomEdit, onLayoutChange,
  }) {
    this.container3D = container3D;
    this.container2D = container2D;
    this.canvas3D = canvas3D;
    this.svg2D = svg2D;
    this.tooltip3D = tooltip3D;
    this.getRooms = getRooms;
    this.getDeviceCountForRoom = getDeviceCountForRoom;
    this.isRoomActive = isRoomActive;
    this.getAppliancesForRoom = getAppliancesForRoom;
    this.onRoomTap = onRoomTap;
    this.onApplianceTap = onApplianceTap;
    this.onRoomEdit = onRoomEdit;
    this.onLayoutChange = onLayoutChange;

    this.mode = 'view';
    this.theme = 'light';
    this.selectedRoomId = null;
    this.hoverRoomId = null;
    this.hoverBubble = null;

    this.dragState = null;
    this.layout = new Map();

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
      // Fit content into the available viewport when entering edit mode
      requestAnimationFrame(() => this.fitToContent());
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
    // Performance tier by device: phones get cheaper antialiasing, a lower
    // pixel-ratio cap, a smaller shadow map and a battery-friendly GPU hint;
    // desktops get full quality. Set once at init (these can't all change live).
    const isMobile = document.documentElement.getAttribute('data-device') === 'mobile';
    this._isMobile = isMobile;
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas3D, antialias: !isMobile, alpha: true,
      powerPreference: isMobile ? 'low-power' : 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(isMobile ? 1.5 : 2, window.devicePixelRatio));
    // Physically-pleasing output: filmic tone mapping + soft shadows.
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene = new THREE.Scene();
    this._applySceneTheme();

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 220);
    this.camera.position.set(9, 13, 13);
    this.camera.lookAt(4, 0, 4);

    this.controls = new OrbitControls(this.camera, this.canvas3D);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 5;
    this.controls.maxDistance = 44;
    this.controls.maxPolarAngle = Math.PI / 2.15;
    this.controls.target.set(4, 0, 4);
    // Gentle "alive" auto-rotation that pauses while the user interacts.
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.55;
    this._idleTimer = null;

    // --- lighting rig: hemisphere bounce + key (shadow-casting) + fill + rim ---
    this._buildLights();

    this.roomGroup = new THREE.Group();
    this.scene.add(this.roomGroup);

    // Raycaster for tap-to-drill-in
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDownAt = null;

    this.canvas3D.addEventListener('pointerdown', (e) => {
      this.pointerDownAt = { x: e.clientX, y: e.clientY, t: Date.now() };
      this._suspendAutoRotate();
    });
    this.canvas3D.addEventListener('pointermove', (e) => this._onHover3D(e));
    this.canvas3D.addEventListener('pointerleave', () => this._hideTooltip());
    this.canvas3D.addEventListener('wheel', () => this._suspendAutoRotate(), { passive: true });
    this.canvas3D.addEventListener('pointerup', (e) => {
      this._scheduleAutoRotate();
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

  _buildLights() {
    const hemi = new THREE.HemisphereLight(0xffffff, 0xb9c4dc, 1.05);
    hemi.position.set(0, 24, 0);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff6ec, 2.3);
    key.position.set(14, 22, 10);
    key.castShadow = true;
    const shadowRes = this._isMobile ? 1024 : 2048;
    key.shadow.mapSize.set(shadowRes, shadowRes);
    key.shadow.radius = 6;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.025;
    const c = key.shadow.camera;
    c.near = 0.5; c.far = 90;
    c.left = -32; c.right = 32; c.top = 32; c.bottom = -32;
    c.updateProjectionMatrix();
    this.scene.add(key);
    this._keyLight = key;

    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.55);
    fill.position.set(-12, 9, -10);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xa9c0ff, 0.4);
    rim.position.set(-6, 5, 16);
    this.scene.add(rim);
  }

  _suspendAutoRotate() {
    this.controls.autoRotate = false;
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
  }
  _scheduleAutoRotate() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => {
      if (this.mode === 'view') this.controls.autoRotate = true;
    }, 4500);
  }

  // Rounded-rectangle Shape centred on the origin (XY plane), for extruded slabs.
  _roundedRectShape(w, d, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -d / 2;
    r = Math.min(r, w / 2, d / 2);
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + d - r);
    s.quadraticCurveTo(x + w, y + d, x + w - r, y + d);
    s.lineTo(x + r, y + d);
    s.quadraticCurveTo(x, y + d, x, y + d - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
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
    // Skip all rendering when the 3D stage isn't on screen (e.g. the user is on
    // a control/room screen). offsetParent is null for display:none ancestors,
    // so this stops the GPU loop + saves battery while the dollhouse is hidden.
    if (this.mode === 'view' && this.container3D.offsetParent !== null) {
      this.controls.update();
      // Animate appliance bubbles bobbing and pulsing softly
      const t = performance.now() / 1000;
      this.roomGroup.traverse((o) => {
        if (o.userData?.isBubble && o.userData?.basePos) {
          const ph = o.userData.bobOffset || 0;
          const bob = Math.sin(t * 1.6 + ph);
          o.position.y = o.userData.basePos.y + bob * 0.08;
          // Subtle pulse on scale
          const s = 0.95 + bob * 0.04;
          o.scale.set(s, s, 1);
        } else if (o.userData?.isDisc) {
          // Contact shadow tracks the bubble overhead: as it rises the shadow
          // shrinks + fades, as it drops the shadow grows + darkens (grounding).
          const ph = o.userData.bobOffset || 0;
          const bob = Math.sin(t * 1.6 + ph);
          const ds = 1 - bob * 0.16;
          o.scale.set(ds, ds, 1);
          o.material.opacity = (o.userData.discBase || 0.16) * (1 - bob * 0.28);
        } else if (o.userData?.isLabel) {
          // Constant on-screen size: scale with camera distance so labels read
          // large whether the user is zoomed all the way in or out.
          const dist = this.camera.position.distanceTo(o.position);
          const h = dist * LABEL_SCREEN_K;
          o.scale.set(h * (o.userData.aspect || 3.2), h, 1);
        }
      });
      this.renderer.render(this.scene, this.camera);
    }
  }

  _applySceneTheme() {
    // Read CSS variables resolved on the current document
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--scene-bg').trim() || '#e8edf5';
    const bgColor = new THREE.Color(bg);
    this.scene.background = bgColor;
    // Gentle distance fog tinted to the background gives depth without haze up close.
    this.scene.fog = new THREE.Fog(bgColor.clone(), 34, 88);
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
    this._roomMeshes = new Map();
    const cs = getComputedStyle(document.documentElement);
    const activeColor   = new THREE.Color(cs.getPropertyValue('--scene-room-on').trim() || '#dbeafe');
    const highlightColor= new THREE.Color(cs.getPropertyValue('--scene-highlight').trim() || '#34d399');

    const rooms = [...this.getRooms().values()];
    const placements = [];
    let bbox = null;
    for (const room of rooms) {
      const fp = this.layout.get(room.room_id) || room.floor_plan;
      if (!fp) continue;
      placements.push(fp);
      const isActive = this.isRoomActive ? this.isRoomActive(room.room_id) : false;
      const group = this._buildRoomMesh(room, fp, { isActive, highlightColor, activeColor });
      group.userData.roomId = room.room_id;
      this.roomGroup.add(group);
      this._roomMeshes.set(room.room_id, group);
      if (!bbox) bbox = { minX: fp.x, minZ: fp.y, maxX: fp.x + fp.width, maxZ: fp.y + fp.height };
      else {
        bbox.minX = Math.min(bbox.minX, fp.x);
        bbox.minZ = Math.min(bbox.minZ, fp.y);
        bbox.maxX = Math.max(bbox.maxX, fp.x + fp.width);
        bbox.maxZ = Math.max(bbox.maxZ, fp.y + fp.height);
      }
    }

    // Corridors — neutral walls + floor (consistent across all corridors)
    const isDarkScene = (document.documentElement.getAttribute('data-theme') === 'dark');
    const corrPal = isDarkScene ? CORRIDOR_PALETTE_DARK : CORRIDOR_PALETTE_LIGHT;
    const corridors = this._findCorridors(placements);
    const corrWallMat  = new THREE.MeshStandardMaterial({ color: new THREE.Color(corrPal.wall), roughness: 0.9, metalness: 0 });
    const corrFloorMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(corrPal.floor), roughness: 0.95, metalness: 0 });
    for (const c of corridors) {
      const isHorizontal = c.width > c.height;
      const cFloor = new THREE.Mesh(
        new THREE.BoxGeometry(c.width, 0.06, c.height),
        corrFloorMat
      );
      cFloor.position.set(c.x + c.width / 2, ROOM_FLOOR_Y, c.y + c.height / 2);
      cFloor.receiveShadow = true;
      this.roomGroup.add(cFloor);
      const halfH = WALL_HEIGHT / 2;
      const addCorrWall = (gw, gd, px, pz) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(gw, WALL_HEIGHT, gd), corrWallMat);
        m.position.set(px, halfH, pz);
        m.castShadow = true; m.receiveShadow = true;
        this.roomGroup.add(m);
      };
      if (isHorizontal) {
        addCorrWall(c.width, WALL_THICK, c.x + c.width / 2, c.y);
        addCorrWall(c.width, WALL_THICK, c.x + c.width / 2, c.y + c.height);
      } else {
        addCorrWall(WALL_THICK, c.height, c.x, c.y + c.height / 2);
        addCorrWall(WALL_THICK, c.height, c.x + c.width, c.y + c.height / 2);
      }
    }

    // Floating podium — a soft rounded slab beneath the whole home so the
    // dollhouse reads as a premium physical model resting on a surface.
    if (bbox) {
      const pad = 1.1;
      const pw = (bbox.maxX - bbox.minX) + pad * 2;
      const pd = (bbox.maxZ - bbox.minZ) + pad * 2;
      const pcx = (bbox.minX + bbox.maxX) / 2;
      const pcz = (bbox.minZ + bbox.maxZ) / 2;
      const isDark = (document.documentElement.getAttribute('data-theme') === 'dark');
      const baseCol = new THREE.Color(isDark ? 0x0e1530 : 0xeef2ff);
      const DEPTH = 0.35, BEVEL = 0.12;
      const shape = this._roundedRectShape(pw, pd, Math.min(1.4, Math.min(pw, pd) * 0.18));
      const slab = new THREE.ExtrudeGeometry(shape, {
        depth: DEPTH, bevelEnabled: true, bevelThickness: BEVEL, bevelSize: BEVEL, bevelSegments: 3, curveSegments: 12,
      });
      // After this rotation the extrude axis runs +Y; shift the whole slab down
      // so its top face rests just below the room floors (which sit at y≈0).
      slab.rotateX(-Math.PI / 2);
      slab.translate(0, -(DEPTH + BEVEL + 0.05), 0);
      const platform = new THREE.Mesh(
        slab,
        new THREE.MeshStandardMaterial({ color: baseCol, roughness: 0.82, metalness: 0.04 })
      );
      platform.position.set(pcx, 0, pcz);
      platform.receiveShadow = true;
      platform.userData.isPodium = true;
      this.roomGroup.add(platform);
    }

    // Recenter camera
    if (bbox) {
      const cx = (bbox.minX + bbox.maxX) / 2;
      const cz = (bbox.minZ + bbox.maxZ) / 2;
      this.controls.target.set(cx, 0, cz);
      const size = Math.max(bbox.maxX - bbox.minX, bbox.maxZ - bbox.minZ);
      // Pull back enough that floating room labels at the edges stay on-canvas.
      const dist = Math.max(10, size * 1.85);
      this.camera.position.set(cx + dist * 0.58, dist * 0.82, cz + dist * 0.58);
    }

    const emptyEl = document.getElementById('floorplan-3d-empty');
    if (emptyEl) emptyEl.style.display = (rooms.filter(r => r.floor_plan).length === 0) ? '' : 'none';
  }

  _buildRoomMesh(room, fp, { isActive, highlightColor, activeColor }) {
    const g = new THREE.Group();
    const w = fp.width, d = fp.height, x = fp.x, z = fp.y;
    const isDark = (document.documentElement.getAttribute('data-theme') === 'dark');
    const pal = paletteForRoom(room, isDark);
    const wallColor  = new THREE.Color(pal.wall);
    // Active rooms glow in the accent colour. In dark mode the key light + ACES
    // tone mapping would blow a bright base colour out to white, so we keep a
    // darkened base and let the emissive provide the recognisable glow.
    const floorColor = isActive
      ? (isDark ? activeColor.clone().multiplyScalar(0.4) : activeColor.clone())
      : new THREE.Color(pal.floor);

    // Floor — PBR so the lighting rig produces gentle gradients + receives shadows.
    const floorMat = new THREE.MeshStandardMaterial({
      color: floorColor, roughness: 0.92, metalness: 0.0,
    });
    if (isActive) {
      floorMat.emissive = activeColor.clone();
      floorMat.emissiveIntensity = isDark ? 0.5 : 0.35;
    }
    const floor = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), floorMat);
    floor.position.set(x + w / 2, ROOM_FLOOR_Y, z + d / 2);
    floor.receiveShadow = true;
    floor.userData.isFloor = true;
    g.add(floor);

    // Hover/selection overlay — translucent green VOLUME (full room from floor to ceiling).
    const overlay = new THREE.Mesh(
      new THREE.BoxGeometry(w - 0.04, WALL_HEIGHT - 0.04, d - 0.04),
      new THREE.MeshBasicMaterial({
        color: highlightColor, transparent: true, opacity: 0.18,
        depthWrite: false,
      })
    );
    overlay.position.set(x + w / 2, WALL_HEIGHT / 2, z + d / 2);
    overlay.visible = false;
    overlay.userData.isOverlay = true;
    g.add(overlay);
    g.userData.overlay = overlay;

    // 4 walls + a slightly-lighter capping rail along each top edge for a
    // crisp "architectural model" finish. Walls cast and receive shadows.
    const wallMat = new THREE.MeshStandardMaterial({ color: wallColor, roughness: 0.88, metalness: 0.0 });
    const capMat  = new THREE.MeshStandardMaterial({
      color: wallColor.clone().lerp(new THREE.Color(0xffffff), 0.45), roughness: 0.7, metalness: 0.0,
    });
    const halfH = WALL_HEIGHT / 2;
    const CAP_H = 0.06, CAP_OVER = 0.04;
    const addWall = (gw, gd, px, pz) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(gw, WALL_HEIGHT, gd), wallMat);
      wall.position.set(px, halfH, pz);
      wall.castShadow = true; wall.receiveShadow = true;
      g.add(wall);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(gw + CAP_OVER, CAP_H, gd + CAP_OVER), capMat);
      cap.position.set(px, WALL_HEIGHT + CAP_H / 2 - 0.005, pz);
      cap.castShadow = true;
      g.add(cap);
    };
    addWall(w, WALL_THICK, x + w / 2, z);          // N
    addWall(w, WALL_THICK, x + w / 2, z + d);      // S
    addWall(WALL_THICK, d, x, z + d / 2);          // W
    addWall(WALL_THICK, d, x + w, z + d / 2);      // E

    // Label well above the walls — no overlap with bubbles
    const sprite = this._buildLabelSprite(room);
    sprite.position.set(x + w / 2, WALL_HEIGHT + 1.4, z + d / 2);
    g.add(sprite);

    // Appliance bubbles (+ a soft contact-shadow disc grounding each one)
    if (this.getAppliancesForRoom) {
      const aps = this.getAppliancesForRoom(room.room_id);
      const n = aps.length;
      aps.forEach((a, i) => {
        const t = n === 1 ? 0 : (i - (n - 1) / 2) / Math.max(1, (n - 1) / 2);
        const spreadX = Math.min(w * 0.55, 0.7 + n * 0.55);
        const bx = x + w / 2 + t * spreadX / 2;
        const bz = z + d / 2;
        const by = 0.5;

        const disc = new THREE.Mesh(
          new THREE.CircleGeometry(0.34, 28),
          new THREE.MeshBasicMaterial({ color: 0x0b1020, transparent: true, opacity: 0.16, depthWrite: false })
        );
        disc.rotation.x = -Math.PI / 2;
        disc.position.set(bx, ROOM_FLOOR_Y + 0.045, bz);
        disc.userData.discBase = 0.16;
        disc.userData.bobOffset = i * 0.7;
        disc.userData.isDisc = true;
        g.add(disc);

        const bubble = this._buildApplianceBubble(a);
        bubble.position.set(bx, by, bz);
        bubble.userData.roomId = room.room_id;
        bubble.userData.applianceId = a.id;
        bubble.userData.deviceId = a.deviceId;
        bubble.userData.bobOffset = i * 0.7;
        bubble.userData.basePos = { x: bx, y: by, z: bz };
        g.add(bubble);
      });
    }

    return g;
  }

  _buildApplianceBubble(appliance) {
    // Sprite with a translucent circle + emoji icon.
    const canvas = document.createElement('canvas');
    const dpr = 2;
    canvas.width  = 192 * dpr;
    canvas.height = 192 * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    const cx = 96, cy = 96, r = 72;

    // Outer soft glow
    const glow = ctx.createRadialGradient(cx, cy, r * 0.4, cx, cy, r * 1.3);
    glow.addColorStop(0, 'rgba(59,130,246,0.32)');
    glow.addColorStop(1, 'rgba(59,130,246,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(cx, cy, r * 1.3, 0, Math.PI * 2); ctx.fill();

    // Inner bubble
    const inner = ctx.createRadialGradient(cx - 18, cy - 22, 6, cx, cy, r);
    const isOn = !!(appliance.state && appliance.state.power);
    if (isOn) {
      inner.addColorStop(0, 'rgba(255,255,255,0.95)');
      inner.addColorStop(0.6, 'rgba(96,165,250,0.85)');
      inner.addColorStop(1, 'rgba(37,99,235,0.85)');
    } else {
      inner.addColorStop(0, 'rgba(255,255,255,0.95)');
      inner.addColorStop(0.55, 'rgba(255,255,255,0.85)');
      inner.addColorStop(1, 'rgba(226,232,240,0.85)');
    }
    ctx.fillStyle = inner;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();

    // Crisp inner ring
    ctx.strokeStyle = isOn ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();

    // Outer accent halo — vivid when on, muted when off
    ctx.strokeStyle = isOn ? 'rgba(96,165,250,0.85)' : 'rgba(148,163,184,0.45)';
    ctx.lineWidth = isOn ? 4 : 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r + 7, 0, Math.PI * 2); ctx.stroke();

    // Icon
    const icon = ({ ac: '❄️', fan: '🌀', generic: '🎛️' })[appliance.type] || '🎛️';
    ctx.font = '60px "Plus Jakarta Sans", sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(icon, cx, cy + 4);

    // Power status dot (top-right) so on/off reads at a glance
    const dotX = cx + r * 0.62, dotY = cy - r * 0.62;
    ctx.beginPath(); ctx.arc(dotX, dotY, 11, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff'; ctx.fill();
    ctx.beginPath(); ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
    ctx.fillStyle = isOn ? '#22c55e' : '#cbd5e1'; ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(0.95, 0.95, 1);
    sprite.renderOrder = 800;
    sprite.userData.isBubble = true;
    return sprite;
  }

  _buildLabelSprite(room) {
    // Apple-style label: large, soft, glassy, with strong but soft shadow.
    const canvas = document.createElement('canvas');
    const dpr = 2;
    canvas.width = 1024 * dpr; canvas.height = 320 * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    const isDark = (document.documentElement.getAttribute('data-theme') === 'dark');
    // Glassy pill that fits the active theme: white frosted on light, deep
    // navy-glass on dark (a white pill in dark mode hides the light text).
    const pill = isDark
      ? { fill: 'rgba(20, 28, 52, 0.92)', shadow: 'rgba(0, 0, 0, 0.45)',
          gradTop: 'rgba(255,255,255,0.06)', gradBot: 'rgba(0,0,0,0.10)',
          border: 'rgba(255,255,255,0.16)', text: '#eef2fc' }
      : { fill: 'rgba(255, 255, 255, 0.96)', shadow: 'rgba(15, 23, 42, 0.22)',
          gradTop: 'rgba(255,255,255,0.0)', gradBot: 'rgba(15,23,42,0.04)',
          border: 'rgba(15, 23, 42, 0.10)', text: '#0f172a' };

    ctx.font = '700 56px "Plus Jakarta Sans", -apple-system, sans-serif';
    const iconText = room.icon || '🚪';
    const nameText = room.name || '';
    const iconWidth = ctx.measureText(iconText).width;
    const nameWidth = ctx.measureText(nameText).width;
    const gap = 28;
    const tw = iconWidth + gap + nameWidth;
    const padX = 56, padY = 30;
    const boxW = tw + padX * 2;
    const boxH = 124;
    const boxX = (1024 - boxW) / 2;
    const boxY = 320 / 2 - boxH / 2;
    const radius = 36;

    // Soft drop shadow under the pill
    ctx.shadowColor = pill.shadow;
    ctx.shadowBlur = 32;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = pill.fill;
    this._roundRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();

    // Reset shadow before painting decorations
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Subtle inner gradient for a slight "frosted" feel
    const grad = ctx.createLinearGradient(0, boxY, 0, boxY + boxH);
    grad.addColorStop(0, pill.gradTop);
    grad.addColorStop(1, pill.gradBot);
    ctx.fillStyle = grad;
    this._roundRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.fill();

    // Thin border line for crispness
    ctx.strokeStyle = pill.border;
    ctx.lineWidth = 2;
    this._roundRect(ctx, boxX, boxY, boxW, boxH, radius);
    ctx.stroke();

    // Text
    ctx.fillStyle = pill.text;
    ctx.textBaseline = 'middle';
    ctx.fillText(iconText, boxX + padX, boxY + boxH / 2 + 2);
    ctx.fillText(nameText, boxX + padX + iconWidth + gap, boxY + boxH / 2 + 2);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const sprite = new THREE.Sprite(mat);
    // The label keeps a constant on-screen size: each frame _animate() scales it
    // by camera distance (see LABEL_SCREEN_K). We store the canvas aspect ratio
    // so width/height stay correct while only the overall size tracks zoom.
    const aspect = canvas.width / canvas.height;
    sprite.userData.isLabel = true;
    sprite.userData.aspect = aspect;
    sprite.scale.set(aspect, 1, 1);
    sprite.renderOrder = 999;
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
    const hit = this._pickHit(e);
    if (!hit) return;
    if (hit.kind === 'bubble') this.onApplianceTap?.(hit.deviceId, hit.applianceId);
    else                       this.onRoomTap?.(hit.roomId);
  }
  _onHover3D(e) {
    const hit = this._pickHit(e);
    // Toggle highlight overlay for hovered room
    if (this._roomMeshes) {
      for (const [rid, mesh] of this._roomMeshes) {
        if (mesh.userData.overlay) {
          const shouldShow = (hit?.roomId === rid) || (this.selectedRoomId === rid);
          mesh.userData.overlay.visible = shouldShow;
        }
      }
    }
    if (hit) {
      const rooms = this.getRooms();
      const room = rooms.get(hit.roomId);
      if (room) {
        const count = this.getDeviceCountForRoom?.(hit.roomId) || 0;
        const tt = this.tooltip3D;
        const label = (hit.kind === 'bubble' && this.getAppliancesForRoom)
          ? `tap to control · ${room.icon || ''} ${room.name}`
          : `${room.icon || '🚪'} ${room.name} — ${count} appliance${count === 1 ? '' : 's'}`;
        tt.style.display = '';
        tt.style.opacity = '1';
        tt.style.left = `${e.offsetX}px`;
        tt.style.top  = `${e.offsetY}px`;
        tt.textContent = label;
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

  // Pick the first room or bubble under the pointer.
  // Returns { kind: 'room'|'bubble', roomId, applianceId?, deviceId? } or null.
  _pickHit(e) {
    const rect = this.canvas3D.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width)  *  2 - 1;
    this.pointer.y = ((e.clientY - rect.top)  / rect.height) * -2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const intersects = this.raycaster.intersectObjects(this.roomGroup.children, true);
    for (const i of intersects) {
      let n = i.object;
      // Bubbles carry their data directly on themselves
      if (n.userData?.isBubble) {
        return { kind: 'bubble', roomId: n.userData.roomId,
                 applianceId: n.userData.applianceId, deviceId: n.userData.deviceId };
      }
      // Otherwise walk up to find the room group
      while (n && !n.userData?.roomId) n = n.parent;
      if (n) return { kind: 'room', roomId: n.userData.roomId };
    }
    return null;
  }

  // =============================================================
  // 2D — SVG editor (with pan + zoom)
  // =============================================================
  _init2D() {
    this.viewBox = { x: 0, y: 0, w: SCENE_W, h: SCENE_H };
    this.svg2D.setAttribute('viewBox', `0 0 ${SCENE_W} ${SCENE_H}`);
    this.svg2D.style.touchAction = 'none';
    this.svg2D.addEventListener('pointerdown',  (e) => this._onSvgPointerDown(e));
    this.svg2D.addEventListener('pointermove',  (e) => this._onSvgPointerMove(e));
    this.svg2D.addEventListener('pointerup',    (e) => this._onSvgPointerUp(e));
    this.svg2D.addEventListener('pointercancel',(e) => this._onSvgPointerUp(e));
    this.svg2D.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      this._zoom(factor, { x: e.offsetX, y: e.offsetY });
    }, { passive: false });
  }

  // Public — called from toolbar buttons
  zoomIn()  { this._zoom(0.8); }
  zoomOut() { this._zoom(1.25); }
  fitToContent() {
    const all = this._getAllPlacements();
    if (all.length === 0) {
      this._setViewBox({ x: 0, y: 0, w: SCENE_W, h: SCENE_H });
      return;
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of all) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + p.width);
      maxY = Math.max(maxY, p.y + p.height);
    }
    // Generous padding so users can grab and drag without rooms hitting edges
    const padX = (maxX - minX) * 0.3 + 2;
    const padY = (maxY - minY) * 0.3 + 2;
    minX -= padX; minY -= padY;
    maxX += padX; maxY += padY;
    const contentW = (maxX - minX) * UNIT_PX;
    const contentH = (maxY - minY) * UNIT_PX;
    const rect = this.svg2D.getBoundingClientRect();
    const aspect = rect.width / Math.max(1, rect.height);
    let finalW = contentW, finalH = contentH;
    if (contentW / contentH > aspect) finalH = contentW / aspect;
    else                              finalW = contentH * aspect;
    const cxPx = (minX + maxX) / 2 * UNIT_PX;
    const cyPx = (minY + maxY) / 2 * UNIT_PX;
    this._setViewBox({ x: cxPx - finalW / 2, y: cyPx - finalH / 2, w: finalW, h: finalH });
  }

  _setViewBox(vb) {
    // Clamp zoom in/out
    const minW = SCENE_W * 0.2;
    const maxW = SCENE_W * 8;
    if (vb.w < minW) { const r = minW / vb.w; vb.w *= r; vb.h *= r; }
    if (vb.w > maxW) { const r = maxW / vb.w; vb.w *= r; vb.h *= r; }
    this.viewBox = vb;
    this.svg2D.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  }

  _zoom(factor, focusPx) {
    const vb = this.viewBox;
    const newW = vb.w * factor;
    const newH = vb.h * factor;
    let newX, newY;
    if (focusPx) {
      const rect = this.svg2D.getBoundingClientRect();
      const fx = vb.x + (focusPx.x / rect.width)  * vb.w;
      const fy = vb.y + (focusPx.y / rect.height) * vb.h;
      newX = fx - (focusPx.x / rect.width)  * newW;
      newY = fy - (focusPx.y / rect.height) * newH;
    } else {
      newX = vb.x + (vb.w - newW) / 2;
      newY = vb.y + (vb.h - newH) / 2;
    }
    this._setViewBox({ x: newX, y: newY, w: newW, h: newH });
  }

  // Detect rooms that are close-but-not-touching and yield connector rects.
  _findCorridors(placements) {
    const out = [];
    const maxGap = 6;
    const minWidth = 0.8;
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const a = placements[i], b = placements[j];
        const xStart = Math.max(a.x, b.x);
        const xEnd   = Math.min(a.x + a.width, b.x + b.width);
        const xOverlap = xEnd - xStart;
        if (xOverlap >= minWidth) {
          const aBottom = a.y + a.height, bBottom = b.y + b.height;
          if (aBottom < b.y && b.y - aBottom <= maxGap && b.y - aBottom > 0.01) {
            out.push({ x: xStart, y: aBottom, width: xOverlap, height: b.y - aBottom }); continue;
          }
          if (bBottom < a.y && a.y - bBottom <= maxGap && a.y - bBottom > 0.01) {
            out.push({ x: xStart, y: bBottom, width: xOverlap, height: a.y - bBottom }); continue;
          }
        }
        const yStart = Math.max(a.y, b.y);
        const yEnd   = Math.min(a.y + a.height, b.y + b.height);
        const yOverlap = yEnd - yStart;
        if (yOverlap >= minWidth) {
          const aRight = a.x + a.width, bRight = b.x + b.width;
          if (aRight < b.x && b.x - aRight <= maxGap && b.x - aRight > 0.01) {
            out.push({ x: aRight, y: yStart, width: b.x - aRight, height: yOverlap }); continue;
          }
          if (bRight < a.x && a.x - bRight <= maxGap && a.x - bRight > 0.01) {
            out.push({ x: bRight, y: yStart, width: a.x - bRight, height: yOverlap });
          }
        }
      }
    }
    return out;
  }

  _rebuild2D() {
    while (this.svg2D.firstChild) this.svg2D.removeChild(this.svg2D.firstChild);
    const ns = 'http://www.w3.org/2000/svg';
    const rooms = [...this.getRooms().values()];
    const placements = [];
    for (const room of rooms) {
      const fp = this.layout.get(room.room_id) || room.floor_plan;
      if (fp) placements.push(fp);
    }
    const corridors = this._findCorridors(placements);
    for (const c of corridors) {
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', c.x * UNIT_PX); rect.setAttribute('y', c.y * UNIT_PX);
      rect.setAttribute('width',  c.width  * UNIT_PX);
      rect.setAttribute('height', c.height * UNIT_PX);
      rect.setAttribute('rx', 4);
      rect.classList.add('fp-corridor');
      this.svg2D.appendChild(rect);
    }
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
    const pal = paletteForRoom(room);

    const g = document.createElementNS(ns, 'g');
    g.dataset.roomId = room.room_id;
    g.setAttribute('transform', `translate(${x},${y})`);

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', 0); rect.setAttribute('y', 0);
    rect.setAttribute('width', w); rect.setAttribute('height', h);
    rect.setAttribute('rx', 8);
    rect.setAttribute('fill', pal.wall);
    rect.setAttribute('fill-opacity', '0.55');
    rect.classList.add('fp-edit-room');
    rect.dataset.role = 'body';
    if (this.selectedRoomId === room.room_id) rect.classList.add('selected');
    rect.dataset.roomId = room.room_id;
    rect.dataset.action = 'move';
    g.appendChild(rect);

    const icon = document.createElementNS(ns, 'text');
    icon.setAttribute('x', w / 2); icon.setAttribute('y', h / 2 - 10);
    icon.setAttribute('text-anchor', 'middle');
    icon.classList.add('fp-room-icon');
    icon.dataset.role = 'icon';
    icon.textContent = room.icon || '🚪';
    g.appendChild(icon);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', w / 2); label.setAttribute('y', h / 2 + 22);
    label.setAttribute('text-anchor', 'middle');
    label.classList.add('fp-room-label');
    label.dataset.role = 'label';
    label.textContent = room.name;
    g.appendChild(label);

    if (this.selectedRoomId === room.room_id) {
      const handles = [
        { x: 0, y: 0, action: 'resize-tl' },
        { x: w, y: 0, action: 'resize-tr' },
        { x: 0, y: h, action: 'resize-bl' },
        { x: w, y: h, action: 'resize-br' },
      ];
      for (const hp of handles) {
        const hit = document.createElementNS(ns, 'circle');
        hit.setAttribute('cx', hp.x); hit.setAttribute('cy', hp.y);
        hit.setAttribute('r', 18);
        hit.setAttribute('fill', 'transparent');
        hit.style.cursor = 'nwse-resize';
        hit.dataset.roomId = room.room_id;
        hit.dataset.action = hp.action;
        g.appendChild(hit);
        const c = document.createElementNS(ns, 'circle');
        c.setAttribute('cx', hp.x); c.setAttribute('cy', hp.y);
        c.setAttribute('r', 9);
        c.classList.add('fp-handle');
        c.dataset.role = `handle-${hp.action}`;
        c.style.pointerEvents = 'none';
        g.appendChild(c);
      }
    }

    this.svg2D.appendChild(g);
  }

  _updateRoomSvg(roomId, fp) {
    const g = this.svg2D.querySelector(`g[data-room-id="${roomId}"]`);
    if (!g) return;
    const x = fp.x * UNIT_PX, y = fp.y * UNIT_PX;
    const w = fp.width * UNIT_PX, h = fp.height * UNIT_PX;
    g.setAttribute('transform', `translate(${x},${y})`);
    const body = g.querySelector('[data-role="body"]');
    if (body) { body.setAttribute('width', w); body.setAttribute('height', h); }
    const icon  = g.querySelector('[data-role="icon"]');
    const label = g.querySelector('[data-role="label"]');
    if (icon)  { icon.setAttribute('x',  w / 2); icon.setAttribute('y',  h / 2 - 10); }
    if (label) { label.setAttribute('x', w / 2); label.setAttribute('y', h / 2 + 22); }
    const positions = {
      'handle-resize-tl': [0, 0], 'handle-resize-tr': [w, 0],
      'handle-resize-bl': [0, h], 'handle-resize-br': [w, h],
    };
    for (const [role, [cx, cy]] of Object.entries(positions)) {
      const c = g.querySelector(`[data-role="${role}"]`);
      if (c) { c.setAttribute('cx', cx); c.setAttribute('cy', cy); }
    }
    const hits = g.querySelectorAll('circle[fill="transparent"]');
    const actionOrder = ['resize-tl', 'resize-tr', 'resize-bl', 'resize-br'];
    hits.forEach((hit, i) => {
      const a = actionOrder[i]; if (!a) return;
      const [cx, cy] = positions[`handle-${a}`];
      hit.setAttribute('cx', cx); hit.setAttribute('cy', cy);
    });
  }

  _svgPoint(e) {
    const pt = this.svg2D.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = this.svg2D.getScreenCTM().inverse();
    return pt.matrixTransform(ctm);
  }

  _onSvgPointerDown(e) {
    const target = e.target.closest('[data-action]');
    if (!target) {
      // Begin pan (and tentatively deselect on release if user didn't drag)
      this.panState = {
        startX: e.clientX, startY: e.clientY,
        startVB: { ...this.viewBox },
        moved: false,
      };
      this.svg2D.setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const roomId = target.dataset.roomId;
    const action = target.dataset.action;
    const wasSelected = this.selectedRoomId === roomId;
    this.selectedRoomId = roomId;
    this._notifySelection();

    const pt = this._svgPoint(e);
    const room = this.getRooms().get(roomId);
    const fp = this.layout.get(roomId) || { ...room.floor_plan };
    this.dragState = { roomId, action, startPt: pt, startFp: { ...fp } };
    this.svg2D.setPointerCapture(e.pointerId);
    if (!wasSelected) this._rebuild2D();
  }

  _onSvgPointerMove(e) {
    if (this.panState) {
      const rect = this.svg2D.getBoundingClientRect();
      const dx = (e.clientX - this.panState.startX);
      const dy = (e.clientY - this.panState.startY);
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) this.panState.moved = true;
      // Convert pixel deltas to viewBox units
      const vbDx = -dx * (this.viewBox.w / rect.width);
      const vbDy = -dy * (this.viewBox.h / rect.height);
      this._setViewBox({
        x: this.panState.startVB.x + vbDx,
        y: this.panState.startVB.y + vbDy,
        w: this.panState.startVB.w,
        h: this.panState.startVB.h,
      });
      return;
    }
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
    nfp.x      = Math.round(nfp.x      * 2) / 2;
    nfp.y      = Math.round(nfp.y      * 2) / 2;
    nfp.width  = Math.round(nfp.width  * 2) / 2;
    nfp.height = Math.round(nfp.height * 2) / 2;
    this.layout.set(this.dragState.roomId, nfp);
    this._updateRoomSvg(this.dragState.roomId, nfp);
  }

  _onSvgPointerUp(e) {
    if (this.panState) {
      try { this.svg2D.releasePointerCapture(e.pointerId); } catch {}
      const moved = this.panState.moved;
      this.panState = null;
      if (!moved) {
        // Treat as a click on empty space → deselect
        this.selectedRoomId = null;
        this._notifySelection();
        this._rebuild2D();
      }
      return;
    }
    if (!this.dragState) return;
    try { this.svg2D.releasePointerCapture(e.pointerId); } catch {}
    const wasDragging = this.dragState;
    this.dragState = null;
    this._rebuild2D();
    if (wasDragging) this.onLayoutChange?.();
  }

  _notifySelection() {
    const editBtn = document.getElementById('edit-selected-room');
    const delBtn  = document.getElementById('delete-selected-room');
    if (editBtn) editBtn.style.display = this.selectedRoomId ? '' : 'none';
    if (delBtn)  delBtn.style.display  = this.selectedRoomId ? '' : 'none';
  }

  getSelectedRoomId() { return this.selectedRoomId; }
  selectRoom(id)      { this.selectedRoomId = id; this._rebuild2D(); this._notifySelection(); }
  clearSelection()    { this.selectedRoomId = null; this._rebuild2D(); this._notifySelection(); }
}
