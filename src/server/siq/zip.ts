// Safe ZIP reading on top of yauzl: entry limits, size limits, bomb protection.
import fs from 'node:fs';
import yauzl from 'yauzl';

export interface ZipLimits {
  maxEntries: number;
  maxTotalUncompressed: number;
  maxEntryUncompressed: number;
  /** Max compression ratio for entries bigger than 1 MB. */
  maxRatio: number;
}

export interface ZipEntryInfo {
  /** Raw name as stored in the archive. */
  rawName: string;
  /** Percent-decoded name ("Images/a b.jpg"). */
  name: string;
  size: number;
  entry: yauzl.Entry;
}

export class SafeZip {
  private constructor(
    private zip: yauzl.ZipFile,
    public entries: ZipEntryInfo[],
  ) {}

  static open(path: string, limits: ZipLimits): Promise<SafeZip> {
    return new Promise((resolve, reject) => {
      yauzl.open(path, { lazyEntries: true, autoClose: false, validateEntrySizes: true, strictFileNames: false }, (err, zip) => {
        if (err || !zip) return reject(new Error('Файл не является корректным ZIP-архивом'));
        const entries: ZipEntryInfo[] = [];
        let total = 0;
        const fail = (msg: string) => {
          zip.close();
          reject(new Error(msg));
        };
        zip.on('error', (e: Error) =>
          fail(/invalid|absolute|relative/i.test(e.message) ? 'Недопустимое имя файла в архиве' : 'Повреждённый ZIP-архив'),
        );
        zip.on('entry', (entry: yauzl.Entry) => {
          if (entries.length >= limits.maxEntries) return fail('Слишком много файлов в архиве');
          const rawName = entry.fileName;
          if (!rawName.endsWith('/')) {
            const size = entry.uncompressedSize;
            if (size > limits.maxEntryUncompressed) return fail(`Слишком большой файл в архиве: ${rawName}`);
            if (size > 1024 * 1024 && entry.compressedSize > 0 && size / entry.compressedSize > limits.maxRatio) {
              return fail('Подозрительно высокая степень сжатия (ZIP-бомба?)');
            }
            total += size;
            if (total > limits.maxTotalUncompressed) return fail('Распакованный размер пакета слишком велик');
            entries.push({ rawName, name: decodeName(rawName), size, entry });
          }
          zip.readEntry();
        });
        zip.on('end', () => resolve(new SafeZip(zip, entries)));
        zip.readEntry();
      });
    });
  }

  find(predicate: (e: ZipEntryInfo) => boolean): ZipEntryInfo | undefined {
    return this.entries.find(predicate);
  }

  /** Reads an entry into memory, enforcing a hard byte limit. */
  readBuffer(info: ZipEntryInfo, maxBytes: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (info.size > maxBytes) return reject(new Error(`Файл ${info.name} слишком большой`));
      this.zip.openReadStream(info.entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('Ошибка чтения архива'));
        const chunks: Buffer[] = [];
        let len = 0;
        stream.on('data', (c: Buffer) => {
          len += c.length;
          if (len > maxBytes) {
            stream.destroy();
            reject(new Error(`Файл ${info.name} слишком большой`));
            return;
          }
          chunks.push(c);
        });
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    });
  }

  /** Extracts an entry to a file path chosen by the caller (never derived from the entry name). */
  extractTo(info: ZipEntryInfo, dest: string, maxBytes: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.zip.openReadStream(info.entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('Ошибка чтения архива'));
        const out = fs.createWriteStream(dest, { flags: 'wx' });
        let len = 0;
        stream.on('data', (c: Buffer) => {
          len += c.length;
          if (len > maxBytes) {
            stream.destroy(new Error(`Файл ${info.name} слишком большой`));
          }
        });
        stream.on('error', (e) => {
          out.destroy();
          fs.rm(dest, { force: true }, () => reject(e));
        });
        out.on('error', reject);
        out.on('finish', () => resolve(len));
        stream.pipe(out);
      });
    });
  }

  close() {
    this.zip.close();
  }
}

function decodeName(raw: string): string {
  const n = raw.replace(/\\/g, '/');
  try {
    return decodeURIComponent(n);
  } catch {
    return n;
  }
}
