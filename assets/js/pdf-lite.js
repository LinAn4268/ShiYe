/*
 * PDFLite：零依赖的“图片页 + 元数据 + 可选链接注释”PDF 写入器。
 * 仅覆盖本站导出所需的最小 PDF 结构，不是通用排版库。
 */
(function (global) {
  'use strict';

  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return new TextEncoder().encode(data);
    throw new Error('PDF 数据片段类型不支持');
  }

  function concat(parts) {
    let total = 0;
    const chunks = parts.map((part) => toBytes(part));
    chunks.forEach((chunk) => { total += chunk.length; });
    const out = new Uint8Array(total);
    let offset = 0;
    chunks.forEach((chunk) => {
      out.set(chunk, offset);
      offset += chunk.length;
    });
    return out;
  }

  function utf16Hex(text) {
    const value = String(text == null ? '' : text);
    let hex = 'FEFF';
    for (let i = 0; i < value.length; i++) {
      hex += value.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
    }
    return '<' + hex + '>';
  }

  function escapeUri(text) {
    return encodeURI(String(text || ''))
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)');
  }

  function pdfDate(date) {
    const value = date instanceof Date ? date : new Date();
    const pad = (number) => String(number).padStart(2, '0');
    const offset = -value.getTimezoneOffset();
    const sign = offset >= 0 ? '+' : '-';
    const hours = pad(Math.floor(Math.abs(offset) / 60));
    const minutes = pad(Math.abs(offset) % 60);
    return 'D:' + value.getFullYear() + pad(value.getMonth() + 1) + pad(value.getDate()) +
      pad(value.getHours()) + pad(value.getMinutes()) + pad(value.getSeconds()) +
      sign + hours + "'" + minutes + "'";
  }

  function buildImagePdf(pages, metadata) {
    if (!Array.isArray(pages) || !pages.length) throw new Error('PDF 至少需要一页');
    const pageWidth = 595.28;
    const pageHeight = 841.89;

    let cursor = 3;
    const pageIds = [];
    const contentIds = [];
    const imageIds = [];
    const annotationIds = [];

    pages.forEach((page) => {
      pageIds.push(cursor++);
      contentIds.push(cursor++);
      imageIds.push(cursor++);
      if (page.links && page.links.length) annotationIds.push(cursor++);
      else annotationIds.push(null);
    });
    const infoId = cursor;
    const maxId = cursor;

    const objectBodies = new Map();
    objectBodies.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
    objectBodies.set(2, '<< /Type /Pages /Kids [' + pageIds.map((id) => id + ' 0 R').join(' ') + '] /Count ' + pages.length + ' >>');

    pages.forEach((page, index) => {
      const pageId = pageIds[index];
      const contentId = contentIds[index];
      const imageId = imageIds[index];
      const annots = annotationIds[index] == null ? '' : ' /Annots [' + annotationIds[index] + ' 0 R]';
      objectBodies.set(pageId,
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + pageWidth + ' ' + pageHeight + '] ' +
        '/Resources << /XObject << /Im0 ' + imageId + ' 0 R >> >> ' +
        '/Contents ' + contentId + ' 0 R' + annots + ' >>');

      const stream = 'q\n' + pageWidth + ' 0 0 ' + pageHeight + ' 0 0 cm\n/Im0 Do\nQ\n';
      const streamBytes = new TextEncoder().encode(stream);
      objectBodies.set(contentId, {
        prefix: '<< /Length ' + streamBytes.length + ' >>\nstream\n',
        bytes: streamBytes,
        suffix: 'endstream'
      });

      const image = page.jpeg;
      if (!(image instanceof Uint8Array)) throw new Error('第 ' + (index + 1) + ' 页图片数据缺失');
      objectBodies.set(imageId, {
        prefix: '<< /Type /XObject /Subtype /Image /Width ' + page.width + ' /Height ' + page.height +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + image.length + ' >>\nstream\n',
        bytes: image,
        suffix: 'endstream'
      });

      if (annotationIds[index] != null && page.links && page.links.length) {
        const link = page.links[0];
        const x1 = Number(link.x) || 0;
        const y1 = Number(link.y) || 0;
        const x2 = x1 + (Number(link.width) || 0);
        const y2 = y1 + (Number(link.height) || 0);
        const rect = [
          (x1 / 794 * pageWidth).toFixed(2),
          (pageHeight - (y2 / 1123 * pageHeight)).toFixed(2),
          (x2 / 794 * pageWidth).toFixed(2),
          (pageHeight - (y1 / 1123 * pageHeight)).toFixed(2)
        ].join(' ');
        objectBodies.set(annotationIds[index],
          '<< /Type /Annot /Subtype /Link /Rect [' + rect + '] /Border [0 0 0] ' +
          '/A << /S /URI /URI (' + escapeUri(link.url) + ') >> >>');
      }
    });

    const meta = metadata || {};
    const created = meta.createdAt instanceof Date ? meta.createdAt : new Date();
    objectBodies.set(infoId,
      '<< /Title ' + utf16Hex(meta.title || '') +
      ' /Author ' + utf16Hex(meta.author || '') +
      ' /Subject ' + utf16Hex(meta.subject || '') +
      ' /Keywords ' + utf16Hex(meta.keywords || '') +
      ' /Creator (Shiyue Export Studio) /Producer (PDFLite 1.0) /CreationDate (' + pdfDate(created) + ') >>');

    const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
    const parts = [header];
    const offsets = new Array(maxId + 1).fill(0);
    let length = new TextEncoder().encode(header).length;

    for (let id = 1; id <= maxId; id++) {
      const body = objectBodies.get(id);
      if (body == null) throw new Error('PDF 对象缺失：' + id);
      offsets[id] = length;
      const prefix = id + ' 0 obj\n';
      const prefixBytes = new TextEncoder().encode(prefix);
      parts.push(prefixBytes);
      length += prefixBytes.length;

      if (typeof body === 'string') {
        const bodyBytes = new TextEncoder().encode(body);
        parts.push(bodyBytes);
        length += bodyBytes.length;
      } else {
        const p = new TextEncoder().encode(body.prefix);
        const s = new TextEncoder().encode('\n' + body.suffix);
        parts.push(p, body.bytes, s);
        length += p.length + body.bytes.length + s.length;
      }

      const endBytes = new TextEncoder().encode('\nendobj\n');
      parts.push(endBytes);
      length += endBytes.length;
    }

    const xrefStart = length;
    let xref = 'xref\n0 ' + (maxId + 1) + '\n0000000000 65535 f \n';
    for (let id = 1; id <= maxId; id++) {
      xref += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
    }
    const trailer = 'trailer\n<< /Size ' + (maxId + 1) + ' /Root 1 0 R /Info ' + infoId + ' 0 R >>\nstartxref\n' + xrefStart + '\n%%EOF\n';
    parts.push(new TextEncoder().encode(xref + trailer));

    return new Blob(parts, { type: 'application/pdf' });
  }

  global.PDFLite = { buildImagePdf };
})(window);
