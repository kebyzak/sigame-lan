// Parser for SIGame .siq packages (ZIP with content.xml + Images/Audio/Video/Html folders).
// Supports format version 5 (<params>/<item>) and legacy version 4 (<scenario>/<atom>).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type {
  ContentKind,
  Package,
  PkgContentItem,
  PkgMedia,
  PkgOption,
  PkgQuestion,
  PkgRound,
  PkgTheme,
  Placement,
  QuestionType,
} from '../../shared/types.js';
import { SafeZip, type ZipEntryInfo, type ZipLimits } from './zip.js';

export interface ImportOptions {
  limits: ZipLimits;
  maxContentXml: number;
}

const FOLDERS: Record<ContentKind, string> = { text: '', image: 'images', audio: 'audio', video: 'video', html: 'html' };

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', svg: 'image/svg+xml', avif: 'image/avif',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac',
  opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg', mkv: 'video/x-matroska',
  html: 'text/html', htm: 'text/html',
};

const QUESTION_TYPES: Record<string, QuestionType> = {
  simple: 'simple',
  stake: 'stake',
  auction: 'stake',
  secret: 'secret',
  cat: 'secret',
  bagcat: 'secret',
  secretpublicprice: 'secretPublicPrice',
  secretnoquestion: 'secretNoQuestion',
  norisk: 'noRisk',
  sponsored: 'noRisk',
  forall: 'forAll',
  stakeall: 'stakeAll',
};

type XNode = any;

const arr = (x: unknown): XNode[] => (x === undefined || x === null || x === '' ? [] : Array.isArray(x) ? x : [x]);
const txt = (n: XNode): string => {
  if (n === undefined || n === null) return '';
  if (typeof n === 'string' || typeof n === 'number' || typeof n === 'boolean') return String(n);
  if (Array.isArray(n)) return n.map(txt).join('');
  const t = n['#text'];
  return t === undefined ? '' : String(t);
};
const attr = (n: XNode, name: string): string | undefined => {
  if (!n || typeof n !== 'object') return undefined;
  const v = n.$?.[name];
  return v === undefined ? undefined : String(v);
};
const isTrue = (v: string | undefined) => v !== undefined && v.toLowerCase() === 'true';
const toInt = (v: string | undefined, def = 0) => {
  const n = parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : def;
};

export async function importSiq(zipPath: string, outDir: string, opts: ImportOptions): Promise<Package> {
  const zip = await SafeZip.open(zipPath, opts.limits);
  try {
    const contentEntry = zip.find((e) => e.name.toLowerCase() === 'content.xml');
    if (!contentEntry) throw new Error('В архиве нет content.xml — это не пакет SIGame');
    const xmlBuf = await zip.readBuffer(contentEntry, opts.maxContentXml);
    let xml = xmlBuf.toString('utf8');
    if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('content.xml содержит DOCTYPE/ENTITY — отклонено из соображений безопасности');

    const builder = new PackageBuilder(zip);
    const pkg = builder.build(xml);

    const mediaDir = path.join(outDir, 'media');
    fs.mkdirSync(mediaDir, { recursive: true });
    for (const [mediaId, { entry, media }] of builder.mediaToExtract) {
      const dest = path.join(mediaDir, media.file);
      try {
        media.size = await zip.extractTo(entry, dest, opts.limits.maxEntryUncompressed);
        pkg.media[mediaId] = media;
      } catch (e) {
        pkg.warnings.push(`Не удалось извлечь файл ${media.name}: ${(e as Error).message}`);
      }
    }
    markMissing(pkg);
    return pkg;
  } finally {
    zip.close();
  }
}

/** Marks content items whose media failed to extract. */
function markMissing(pkg: Package) {
  const check = (items: PkgContentItem[]) => {
    for (const it of items) {
      if (it.mediaId && !pkg.media[it.mediaId]) {
        it.missing = true;
        delete it.mediaId;
      }
    }
  };
  for (const r of pkg.rounds)
    for (const t of r.themes)
      for (const q of t.questions) {
        check(q.question);
        check(q.answer);
        q.options?.forEach((o) => check(o.content));
      }
  if (pkg.logoMediaId && !pkg.media[pkg.logoMediaId]) delete pkg.logoMediaId;
}

class PackageBuilder {
  warnings = new Set<string>();
  mediaToExtract = new Map<string, { entry: ZipEntryInfo; media: PkgMedia }>();
  private byEntry = new Map<string, string>();
  private byPath = new Map<string, ZipEntryInfo>();
  private byBase = new Map<string, ZipEntryInfo>();

  constructor(zip: SafeZip) {
    for (const e of zip.entries) {
      const lower = e.name.toLowerCase();
      this.byPath.set(lower, e);
      const base = lower.split('/').pop()!;
      if (!this.byBase.has(base)) this.byBase.set(base, e);
    }
  }

  build(xml: string): Package {
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '',
      attributesGroupName: '$',
      textNodeName: '#text',
      parseTagValue: false,
      parseAttributeValue: false,
      trimValues: true,
      processEntities: true,
      htmlEntities: false,
      isArray: (name) =>
        ['round', 'theme', 'question', 'param', 'item', 'answer', 'atom', 'author', 'tag', 'file', 'comments'].includes(name),
    });
    let doc: XNode;
    try {
      doc = parser.parse(xml);
    } catch (e) {
      throw new Error('Ошибка разбора content.xml: ' + (e as Error).message);
    }
    const root = doc?.package;
    if (!root) throw new Error('content.xml не содержит элемента <package>');

    const version = toInt(attr(root, 'version'), 4);
    const rounds: PkgRound[] = arr(root.rounds?.round).map((r, ri) => this.parseRound(r, ri));
    if (rounds.length === 0) throw new Error('В пакете нет раундов');

    const logo = attr(root, 'logo');
    const logoMediaId = logo ? this.mediaRef('image', logo.replace(/^@/, ''))?.mediaId : undefined;

    const authors = arr(root.info?.authors?.author).map(txt).filter(Boolean);
    return {
      id: crypto.randomUUID(),
      name: attr(root, 'name')?.trim() || 'Без названия',
      author: authors.join(', ') || undefined,
      version,
      logoMediaId,
      rounds,
      media: {},
      warnings: [...this.warnings].slice(0, 100),
      importedAt: Date.now(),
    };
  }

  private parseRound(r: XNode, ri: number): PkgRound {
    const type = attr(r, 'type')?.toLowerCase() === 'final' ? 'final' : 'standard';
    const themes: PkgTheme[] = arr(r.themes?.theme).map((t) => ({
      name: attr(t, 'name')?.trim() || 'Тема',
      comment: comments(t.info) || undefined,
      questions: arr(t.questions?.question).map((q) => this.parseQuestion(q, type)),
    }));
    // Resolve "min or max of round" choices for secret questions with no explicit prices.
    const prices = themes.flatMap((t) => t.questions.map((q) => q.price)).filter((p) => p > 0);
    const min = prices.length ? Math.min(...prices) : 0;
    const max = prices.length ? Math.max(...prices) : 0;
    for (const t of themes)
      for (const q of t.questions)
        if (q.secretPrices && q.secretPrices.length === 0) q.secretPrices = min === max ? [min] : [min, max];
    return { name: attr(r, 'name')?.trim() || `Раунд ${ri + 1}`, type, themes };
  }

  private parseQuestion(q: XNode, roundType: 'standard' | 'final'): PkgQuestion {
    const price = toInt(attr(q, 'price'), 0);
    const result: PkgQuestion = {
      price,
      type: 'simple',
      question: [],
      answer: [],
      right: arr(q.right?.answer).map((a) => txt(a).trim()).filter(Boolean),
      wrong: arr(q.wrong?.answer).map((a) => txt(a).trim()).filter(Boolean),
      answerType: 'text',
      comment: comments(q.info) || undefined,
    };

    let rawType = attr(q, 'type');
    if (q.scenario !== undefined) {
      this.parseV4(q, result);
      rawType = attr(q.type, 'name') ?? rawType;
    } else {
      this.parseV5(q, result);
    }

    if (rawType && rawType.trim()) {
      const t = QUESTION_TYPES[rawType.trim().toLowerCase()];
      if (t) result.type = t;
      else this.warnings.add(`Неизвестный тип вопроса «${rawType}» — сыгран как обычный`);
    } else if (roundType === 'final') {
      result.type = 'stakeAll';
    }
    if (roundType === 'final' && result.type === 'simple') result.type = 'stakeAll';
    if ((result.type === 'secret' || result.type === 'secretPublicPrice' || result.type === 'secretNoQuestion') && !result.secretPrices) {
      result.secretPrices = price > 0 ? [price] : [];
    }
    return result;
  }

  private parseV5(q: XNode, out: PkgQuestion) {
    for (const p of arr(q.params?.param)) {
      const name = attr(p, 'name') ?? '';
      switch (name) {
        case 'question':
          out.question = this.parseItems(p);
          break;
        case 'answer':
          out.answer = this.parseItems(p);
          break;
        case 'answerType': {
          const v = txt(p).trim().toLowerCase();
          out.answerType = v === 'select' ? 'select' : v === 'number' || v === 'numeric' ? 'number' : 'text';
          break;
        }
        case 'answerOptions':
          out.options = arr(p.param).map(
            (o): PkgOption => ({ label: attr(o, 'name') ?? '?', content: this.parseItems(o) }),
          );
          break;
        case 'answerDeviation':
          out.answerDeviation = toInt(txt(p), 0);
          break;
        case 'theme':
          out.secretTheme = txt(p).trim() || undefined;
          break;
        case 'price': {
          const ns = p.numberSet;
          if (ns) {
            out.secretPrices = numberSet(toInt(attr(ns, 'minimum')), toInt(attr(ns, 'maximum')), toInt(attr(ns, 'step')));
          } else {
            const v = toInt(txt(p), -1);
            if (v >= 0) out.secretPrices = v === 0 ? [] : [v];
          }
          break;
        }
        case 'selectionMode':
          break;
        default:
          if (attr(p, 'type') === 'content') {
            this.warnings.add(`Неизвестный параметр вопроса «${name}» пропущен`);
          }
      }
    }
  }

  private parseItems(p: XNode): PkgContentItem[] {
    const items: PkgContentItem[] = [];
    for (const it of arr(p.item)) {
      const kindRaw = (attr(it, 'type') ?? 'text').toLowerCase();
      const kind: ContentKind = (['text', 'image', 'audio', 'video', 'html'] as const).includes(kindRaw as ContentKind)
        ? (kindRaw as ContentKind)
        : kindRaw === 'voice'
          ? 'audio'
          : 'text';
      const placementRaw = (attr(it, 'placement') ?? 'screen').toLowerCase();
      const placement: Placement = placementRaw === 'replic' ? 'replic' : placementRaw === 'background' ? 'background' : 'screen';
      const value = txt(it).trim();
      if (kind === 'text') {
        if (value) items.push({ kind, text: value, placement });
        continue;
      }
      if (isTrue(attr(it, 'isRef'))) {
        items.push(this.mediaRef(kind, value, placement) ?? { kind, placement, name: value, missing: true });
      } else if (/^https?:\/\//i.test(value)) {
        items.push({ kind, url: value, placement });
      } else if (value) {
        items.push({ kind, placement, name: value, missing: true });
      }
    }
    return items;
  }

  private parseV4(q: XNode, out: PkgQuestion) {
    let target = out.question;
    for (const a of arr(q.scenario?.atom)) {
      const type = (attr(a, 'type') ?? 'text').toLowerCase();
      const value = txt(a).trim();
      if (type === 'marker') {
        target = out.answer;
        continue;
      }
      if (type === 'text' || type === 'say') {
        if (value) target.push({ kind: 'text', text: value, placement: type === 'say' ? 'replic' : 'screen' });
        continue;
      }
      const kind: ContentKind | null =
        type === 'image' ? 'image' : type === 'voice' || type === 'audio' ? 'audio' : type === 'video' ? 'video' : type === 'html' ? 'html' : null;
      if (!kind) {
        this.warnings.add(`Неподдерживаемый тип фрагмента «${type}»`);
        continue;
      }
      const placement: Placement = kind === 'audio' ? 'background' : 'screen';
      if (value.startsWith('@')) {
        target.push(this.mediaRef(kind, value.slice(1), placement) ?? { kind, placement, name: value.slice(1), missing: true });
      } else if (/^https?:\/\//i.test(value)) {
        target.push({ kind, url: value, placement });
      }
    }
    // Legacy question types: <type name="cat"><param name="theme">..</param><param name="cost">..</param></type>
    if (q.type && typeof q.type === 'object') {
      for (const p of arr(q.type.param)) {
        const name = attr(p, 'name');
        if (name === 'theme') out.secretTheme = txt(p).trim() || undefined;
        if (name === 'cost') {
          const c = toInt(txt(p), 0);
          out.secretPrices = c > 0 ? [c] : [];
        }
      }
    }
  }

  /** Resolves a media reference to a zip entry and registers it for extraction. */
  mediaRef(kind: ContentKind, name: string, placement: Placement = 'screen'): PkgContentItem | null {
    const clean = name.trim();
    if (!clean) return null;
    const candidates = [clean];
    try {
      const d = decodeURIComponent(clean);
      if (d !== clean) candidates.push(d);
    } catch {
      /* ignore */
    }
    let entry: ZipEntryInfo | undefined;
    for (const c of candidates) {
      const lower = c.toLowerCase();
      entry = this.byPath.get(`${FOLDERS[kind]}/${lower}`) ?? this.byPath.get(lower) ?? this.byBase.get(lower.split('/').pop()!);
      if (entry) break;
    }
    if (!entry) {
      this.warnings.add(`Не найден файл: ${clean}`);
      return null;
    }
    let mediaId = this.byEntry.get(entry.name);
    if (!mediaId) {
      mediaId = crypto.randomBytes(12).toString('hex');
      const ext = (/\.([a-z0-9]{1,5})$/i.exec(entry.name)?.[1] ?? 'bin').toLowerCase();
      const mime = MIME[ext] ?? 'application/octet-stream';
      if (!MIME[ext]) this.warnings.add(`Неизвестный формат файла: ${entry.name}`);
      if (['avi', 'wmv', 'mkv', 'flv'].includes(ext)) this.warnings.add(`Формат ${ext} может не воспроизводиться в браузере: ${entry.name}`);
      this.byEntry.set(entry.name, mediaId);
      this.mediaToExtract.set(mediaId, {
        entry,
        media: { file: `${mediaId}.${ext}`, mime, kind, name: entry.name, size: entry.size },
      });
    }
    return { kind, mediaId, placement, name: entry.name.split('/').pop() };
  }
}

function comments(info: XNode): string {
  return arr(info?.comments).map(txt).join('\n').trim();
}

function numberSet(min: number, max: number, step: number): number[] {
  if (min === 0 && max === 0) return [];
  if (step <= 0 || max <= min) return [...new Set([min, max])].filter((v) => v > 0);
  const out: number[] = [];
  for (let v = min; v <= max && out.length < 50; v += step) out.push(v);
  return out;
}
