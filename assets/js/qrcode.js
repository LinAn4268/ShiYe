/*
 * QRCodeLite：零依赖 QR Code 编码器（Byte 模式，纠错等级 H，版本 1–20）。
 * 用于本站“扫码阅读原文”的原文链接，最长可容纳约 385 字节。
 * 参考 ISO/IEC 18004 的公开编码规则实现。
 */
(function (global) {
  'use strict';

  const ECC_H_FORMAT_BITS = 2; // 纠错等级 H 的格式信息编码为 10

  // H 级 RS 分块表：[块数, 每块总码字, 每块数据码字]。
  // 每个版本内各块的纠错码字数相同，但数据码字数可能分两组。
  const RS_BLOCKS_H = {
    1: [[1, 26, 9]],
    2: [[1, 44, 16]],
    3: [[2, 35, 13]],
    4: [[4, 25, 9]],
    5: [[2, 33, 11], [2, 34, 12]],
    6: [[4, 43, 15]],
    7: [[4, 39, 13], [1, 40, 14]],
    8: [[4, 40, 14], [2, 41, 15]],
    9: [[4, 36, 12], [4, 37, 13]],
    10: [[6, 43, 15], [2, 44, 16]],
    11: [[3, 36, 12], [8, 37, 13]],
    12: [[7, 42, 14], [4, 43, 15]],
    13: [[12, 33, 11], [4, 34, 12]],
    14: [[11, 36, 12], [5, 37, 13]],
    15: [[11, 36, 12], [7, 37, 13]],
    16: [[3, 45, 15], [13, 46, 16]],
    17: [[2, 42, 14], [17, 43, 15]],
    18: [[2, 42, 14], [19, 43, 15]],
    19: [[9, 39, 13], [16, 40, 14]],
    20: [[15, 43, 15], [10, 44, 16]]
  };

  const ALIGNMENT = [
    null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
    [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66],
    [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78],
    [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90]
  ];

  function blockStats(version) {
    const groups = RS_BLOCKS_H[version];
    if (!groups) throw new Error('不支持的二维码版本：' + version);
    let total = 0;
    let data = 0;
    let blocks = 0;
    let eccLength = null;
    for (const group of groups) {
      const count = group[0];
      const totalCodewords = group[1];
      const dataCodewords = group[2];
      total += count * totalCodewords;
      data += count * dataCodewords;
      blocks += count;
      const ecc = totalCodewords - dataCodewords;
      if (eccLength === null) eccLength = ecc;
      else if (eccLength !== ecc) throw new Error('二维码分块表的纠错长度不一致。');
    }
    return { total, data, blocks, eccLength };
  }

  const EXP = new Array(512);
  const LOG = new Array(256);
  (function initGalois() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  function utf8Bytes(text) {
    const s = String(text);
    const out = [];
    for (let i = 0; i < s.length; i++) {
      let code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          i++;
        }
      }
      if (code < 0x80) out.push(code);
      else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
    return out;
  }

  function appendBits(bits, value, length) {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  }

  function chooseVersion(byteLength) {
    for (let version = 1; version <= 20; version++) {
      const dataCodewords = blockStats(version).data;
      const countBits = version < 10 ? 8 : 16;
      const capacity = Math.floor((dataCodewords * 8 - 4 - countBits) / 8);
      if (byteLength <= capacity) return version;
    }
    throw new Error('原文链接过长，超出内置二维码版本 20 的容量。');
  }

  function makeDataCodewords(bytes, version) {
    const dataCodewords = blockStats(version).data;
    const bits = [];
    appendBits(bits, 0x4, 4); // Byte mode
    appendBits(bits, bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => appendBits(bits, b, 8));
    const capacityBits = dataCodewords * 8;
    const terminator = Math.min(4, capacityBits - bits.length);
    for (let i = 0; i < terminator; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    const result = [];
    for (let i = 0; i < bits.length; i += 8) {
      let value = 0;
      for (let j = 0; j < 8; j++) value = (value << 1) | bits[i + j];
      result.push(value);
    }
    let pad = 0;
    while (result.length < dataCodewords) {
      result.push(pad % 2 === 0 ? 0xec : 0x11);
      pad++;
    }
    return result;
  }

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly.slice(1);
  }

  function rsEncode(data, eccLength) {
    const gen = rsGenerator(eccLength);
    const remainder = new Array(eccLength).fill(0);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ remainder[0];
      remainder.shift();
      remainder.push(0);
      if (factor !== 0) {
        for (let i = 0; i < eccLength; i++) {
          remainder[i] ^= gfMul(gen[i], factor);
        }
      }
    }
    return remainder;
  }

  function interleave(dataCodewords, version) {
    const stats = blockStats(version);
    const blockCount = stats.blocks;
    const eccLength = stats.eccLength;
    const totalData = stats.data;
    const shortLength = Math.floor(totalData / blockCount);
    const longCount = totalData % blockCount;
    const blocks = [];
    let offset = 0;
    for (let i = 0; i < blockCount; i++) {
      const length = shortLength + (i >= blockCount - longCount ? 1 : 0);
      const data = dataCodewords.slice(offset, offset + length);
      offset += length;
      blocks.push({ data, ecc: rsEncode(data, eccLength) });
    }
    const result = [];
    const maxDataLength = shortLength + (longCount > 0 ? 1 : 0);
    for (let i = 0; i < maxDataLength; i++) {
      for (const block of blocks) {
        if (i < block.data.length) result.push(block.data[i]);
      }
    }
    for (let i = 0; i < eccLength; i++) {
      for (const block of blocks) result.push(block.ecc[i]);
    }
    return result;
  }

  function createMatrix(size) {
    return {
      size,
      modules: Array.from({ length: size }, () => new Array(size).fill(false)),
      isFunction: Array.from({ length: size }, () => new Array(size).fill(false))
    };
  }

  function setFunction(m, x, y, dark) {
    if (x < 0 || y < 0 || x >= m.size || y >= m.size) return;
    m.modules[y][x] = !!dark;
    m.isFunction[y][x] = true;
  }

  function drawFinder(m, cx, cy) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const dark = dist === 0 || dist === 1 || dist === 3;
        setFunction(m, cx + dx, cy + dy, dark);
      }
    }
  }

  function drawFunctionPatterns(m, version, mask) {
    const size = m.size;
    drawFinder(m, 3, 3);
    drawFinder(m, size - 4, 3);
    drawFinder(m, 3, size - 4);

    for (let i = 8; i < size - 8; i++) {
      setFunction(m, i, 6, i % 2 === 0);
      setFunction(m, 6, i, i % 2 === 0);
    }

    const centers = ALIGNMENT[version];
    for (const cx of centers) {
      for (const cy of centers) {
        if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            setFunction(m, cx + dx, cy + dy, dist !== 1);
          }
        }
      }
    }

    drawFormatBits(m, mask);

    if (version >= 7) {
      let remainder = version;
      for (let i = 0; i < 12; i++) {
        remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
      }
      const versionBits = (version << 12) | remainder;
      for (let i = 0; i < 18; i++) {
        const bit = (versionBits >>> i) & 1;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunction(m, a, b, bit);
        setFunction(m, b, a, bit);
      }
    }
  }

  function drawFormatBits(m, mask) {
    const size = m.size;
    const data = (ECC_H_FORMAT_BITS << 3) | mask;
    let remainder = data;
    for (let i = 0; i < 10; i++) {
      remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    }
    const bits = ((data << 10) | remainder) ^ 0x5412;
    const bit = (index) => ((bits >>> index) & 1) !== 0;

    for (let i = 0; i <= 5; i++) setFunction(m, 8, i, bit(i));
    setFunction(m, 8, 7, bit(6));
    setFunction(m, 8, 8, bit(7));
    setFunction(m, 7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFunction(m, 14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFunction(m, size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFunction(m, 8, size - 15 + i, bit(i));
    setFunction(m, 8, size - 8, true); // 固定暗模块
  }

  function placeData(m, bits) {
    const size = m.size;
    let index = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!m.isFunction[y][x] && index < bits.length) {
            m.modules[y][x] = bits[index] === 1;
            index++;
          }
        }
      }
    }
    if (index !== bits.length) throw new Error('QR 数据放置不完整。');
  }

  function maskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return false;
    }
  }

  function buildMatrix(dataBits, version, mask) {
    const size = 17 + 4 * version;
    const m = createMatrix(size);
    drawFunctionPatterns(m, version, mask);
    placeData(m, dataBits);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (!m.isFunction[y][x] && maskBit(mask, x, y)) {
          m.modules[y][x] = !m.modules[y][x];
        }
      }
    }
    return m;
  }

  function penalty(m) {
    const size = m.size;
    const modules = m.modules;
    let score = 0;

    for (let y = 0; y < size; y++) {
      let runColor = modules[y][0];
      let runLength = 1;
      for (let x = 1; x < size; x++) {
        if (modules[y][x] === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) score += 3 + runLength - 5;
          runColor = modules[y][x];
          runLength = 1;
        }
      }
      if (runLength >= 5) score += 3 + runLength - 5;
    }

    for (let x = 0; x < size; x++) {
      let runColor = modules[0][x];
      let runLength = 1;
      for (let y = 1; y < size; y++) {
        if (modules[y][x] === runColor) {
          runLength++;
        } else {
          if (runLength >= 5) score += 3 + runLength - 5;
          runColor = modules[y][x];
          runLength = 1;
        }
      }
      if (runLength >= 5) score += 3 + runLength - 5;
    }

    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) {
          score += 3;
        }
      }
    }

    const patternA = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const patternB = patternA.slice().reverse();
    const matches = (line, start, pattern) => {
      for (let i = 0; i < pattern.length; i++) {
        if ((line[start + i] ? 1 : 0) !== pattern[i]) return false;
      }
      return true;
    };
    for (let y = 0; y < size; y++) {
      for (let x = 0; x <= size - 11; x++) {
        if (matches(modules[y], x, patternA) || matches(modules[y], x, patternB)) score += 40;
      }
    }
    for (let x = 0; x < size; x++) {
      const column = [];
      for (let y = 0; y < size; y++) column.push(modules[y][x]);
      for (let y = 0; y <= size - 11; y++) {
        if (matches(column, y, patternA) || matches(column, y, patternB)) score += 40;
      }
    }

    let dark = 0;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) if (modules[y][x]) dark++;
    }
    const total = size * size;
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }

  function encode(text) {
    const bytes = utf8Bytes(text);
    const version = chooseVersion(bytes.length);
    const dataCodewords = makeDataCodewords(bytes, version);
    const allCodewords = interleave(dataCodewords, version);
    const dataBits = [];
    allCodewords.forEach((byte) => appendBits(dataBits, byte, 8));

    let best = null;
    let bestPenalty = Infinity;
    let bestMask = 0;
    for (let mask = 0; mask < 8; mask++) {
      const matrix = buildMatrix(dataBits, version, mask);
      const score = penalty(matrix);
      if (score < bestPenalty) {
        bestPenalty = score;
        best = matrix;
        bestMask = mask;
      }
    }
    return { size: best.size, modules: best.modules, version, mask: bestMask };
  }

  function toCanvas(text, options) {
    const opts = options || {};
    const qr = encode(text);
    const quiet = opts.quietZone == null ? 4 : Math.max(0, opts.quietZone);
    const target = opts.size || 512;
    const total = qr.size + quiet * 2;
    const scale = Math.max(1, Math.floor(target / total));
    const pixels = total * scale;
    const canvas = document.createElement('canvas');
    canvas.width = pixels;
    canvas.height = pixels;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = opts.light || '#ffffff';
    ctx.fillRect(0, 0, pixels, pixels);
    ctx.fillStyle = opts.dark || '#111111';
    for (let y = 0; y < qr.size; y++) {
      for (let x = 0; x < qr.size; x++) {
        if (qr.modules[y][x]) {
          ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
        }
      }
    }
    return canvas;
  }

  function toDataURL(text, options) {
    return toCanvas(text, options).toDataURL('image/png');
  }

  global.QRCodeLite = { encode, toCanvas, toDataURL };
})(window);
