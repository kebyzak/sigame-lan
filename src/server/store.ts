// Local persistence: game state, host token and imported packages live in ./data.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Package } from '../shared/types.js';
import { type GameState, initialState } from './game/state.js';

export class Store {
  readonly packagesDir: string;
  readonly uploadsDir: string;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(readonly dir: string) {
    this.packagesDir = path.join(dir, 'packages');
    this.uploadsDir = path.join(dir, 'uploads');
    fs.mkdirSync(this.packagesDir, { recursive: true });
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    // Leftovers from interrupted uploads.
    for (const f of fs.readdirSync(this.uploadsDir)) fs.rmSync(path.join(this.uploadsDir, f), { force: true, recursive: true });
  }

  hostToken(): string {
    const file = path.join(this.dir, 'host-token');
    try {
      const t = fs.readFileSync(file, 'utf8').trim();
      if (t.length >= 32) return t;
    } catch {
      /* create below */
    }
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(file, t, { mode: 0o600 });
    return t;
  }

  loadState(): GameState {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.dir, 'state.json'), 'utf8'));
      if (raw?.version === 1) return { ...initialState(), ...raw };
    } catch {
      /* fresh state */
    }
    return initialState();
  }

  /** Debounced atomic write. */
  saveState(state: GameState) {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.writeNow(state);
    }, 250);
  }

  writeNow(state: GameState) {
    const file = path.join(this.dir, 'state.json');
    const tmp = file + '.tmp';
    try {
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, file);
    } catch (e) {
      console.error('Не удалось сохранить состояние:', e);
    }
  }

  packageDir(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad package id');
    return path.join(this.packagesDir, id);
  }

  savePackage(pkg: Package) {
    fs.writeFileSync(path.join(this.packageDir(pkg.id), 'package.json'), JSON.stringify(pkg));
  }

  loadPackage(id: string | null): Package | null {
    if (!id) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(this.packageDir(id), 'package.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** Removes every imported package except the given one. */
  prunePackages(keepId: string) {
    for (const d of fs.readdirSync(this.packagesDir)) {
      if (d !== keepId) fs.rmSync(path.join(this.packagesDir, d), { recursive: true, force: true });
    }
  }
}
