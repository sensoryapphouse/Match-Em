/* WMF/EMF Parser and SVG Renderer
 * Extracted from wmf2svg.html by Sensory Software
 * Shared module for runtime WMF→SVG conversion in web apps
 *
 * Usage:
 *   const buf = await fetch('file.wmf').then(r => r.arrayBuffer());
 *   const dv = new DataView(buf);
 *   const magic = dv.getUint32(0, true);
 *   const isEMF = (magic === 1 && buf.byteLength >= 44 && dv.getUint32(40, true) === 0x464D4520);
 *   const parser = isEMF ? new EMFParser(buf) : new WMFParser(buf);
 *   const parsed = parser.parse();
 *   const renderer = new SVGRenderer(parsed);
 *   const svgString = renderer.render();
 */
'use strict';

// ============================================================
// WMF Parser
// ============================================================

class WMFParser {
  constructor(buffer) {
    this.data = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
    this.log = [];
    this.records = [];
    this.mdcrRecords = [];
    this.placeable = null;
    this.header = null;
  }

  u8(off) { return this.data.getUint8(off); }
  u16(off) { return this.data.getUint16(off, true); }
  i16(off) { return this.data.getInt16(off, true); }
  u32(off) { return this.data.getUint32(off, true); }

  info(msg) { this.log.push({ level: 'info', msg }); }
  warn(msg) { this.log.push({ level: 'warn', msg }); }
  error(msg) { this.log.push({ level: 'err', msg }); }

  parse() {
    this.parsePlaceableHeader();
    this.parseMetaHeader();
    this.parseRecords();
    return {
      placeable: this.placeable,
      header: this.header,
      records: this.records,
      mdcrRecords: this.mdcrRecords,
      log: this.log
    };
  }

  parsePlaceableHeader() {
    const magic = this.u32(0);
    if (magic === 0x9AC6CDD7) {
      this.placeable = {
        left: this.i16(6),
        top: this.i16(8),
        right: this.i16(10),
        bottom: this.i16(12),
        inch: this.u16(14)
      };
      this.offset = 22;
      this.info(`Placeable WMF: bbox=(${this.placeable.left},${this.placeable.top})-(${this.placeable.right},${this.placeable.bottom}), inch=${this.placeable.inch}`);
    } else {
      this.offset = 0;
      this.info('Standard WMF (no placeable header)');
    }
  }

  parseMetaHeader() {
    const off = this.offset;
    this.header = {
      type: this.u16(off),
      headerSize: this.u16(off + 2),
      version: this.u16(off + 4),
      fileSize: this.u32(off + 6),
      numObjects: this.u16(off + 10),
      maxRecord: this.u32(off + 12),
    };
    this.offset = off + this.header.headerSize * 2;
    this.info(`Header: version=0x${this.header.version.toString(16)}, objects=${this.header.numObjects}, fileSize=${this.header.fileSize} WORDs`);
  }

  parseRecords() {
    let safety = 0;
    while (this.offset < this.data.byteLength && safety < 50000) {
      safety++;
      if (this.offset + 6 > this.data.byteLength) break;

      const recOff = this.offset;
      const recSize = this.u32(recOff);
      const recFunc = this.u16(recOff + 4);

      if (recSize < 3) {
        this.error(`Invalid record size ${recSize} at offset 0x${recOff.toString(16)}`);
        break;
      }

      const rec = this.parseRecord(recOff, recSize, recFunc);
      if (rec) this.records.push(rec);

      if (recFunc === 0x0000) {
        this.info('EOF record reached');
        break;
      }

      this.offset = recOff + recSize * 2;
    }
    this.info(`Parsed ${this.records.length} records, ${this.mdcrRecords.length} MDCR metadata records`);
  }

  parseRecord(off, size, func) {
    const paramOff = off + 6;
    const paramBytes = size * 2 - 6;

    switch (func) {
      case 0x0000: return { type: 'EOF', off };

      // State records
      case 0x0103: return { type: 'SetMapMode', mode: this.u16(paramOff), off };
      case 0x020B: return { type: 'SetWindowOrg', y: this.i16(paramOff), x: this.i16(paramOff + 2), off };
      case 0x020C: return { type: 'SetWindowExt', h: this.i16(paramOff), w: this.i16(paramOff + 2), off };
      case 0x020D: return { type: 'SetViewportOrg', y: this.i16(paramOff), x: this.i16(paramOff + 2), off };
      case 0x020E: return { type: 'SetViewportExt', h: this.i16(paramOff), w: this.i16(paramOff + 2), off };
      case 0x0102: return { type: 'SetBkMode', mode: this.u16(paramOff), off };
      case 0x0104: return { type: 'SetROP2', mode: this.u16(paramOff), off };
      case 0x0106: return { type: 'SetPolyFillMode', mode: this.u16(paramOff), off };
      case 0x0201: return { type: 'SetBkColor', color: this.parseColorRef(paramOff), off };
      case 0x0209: return { type: 'SetTextColor', color: this.parseColorRef(paramOff), off };
      case 0x012E: return { type: 'SetTextAlign', align: this.u16(paramOff), off };
      case 0x0214: return { type: 'MoveTo', y: this.i16(paramOff), x: this.i16(paramOff + 2), off };
      case 0x001E: return { type: 'SaveDC', off };
      case 0x0127: return { type: 'RestoreDC', dc: this.i16(paramOff), off };

      // Object records
      case 0x02FA: return this.parsePen(paramOff, off);
      case 0x02FC: return this.parseBrush(paramOff, off);
      case 0x02FB: return this.parseFont(paramOff, paramBytes, off);
      case 0x012D: return { type: 'SelectObject', index: this.u16(paramOff), off };
      case 0x01F0: return { type: 'DeleteObject', index: this.u16(paramOff), off };

      // Drawing records
      case 0x0324: return this.parsePolygon(paramOff, off);
      case 0x0325: return this.parsePolyline(paramOff, off);
      case 0x0538: return this.parsePolyPolygon(paramOff, off);
      case 0x0213: return { type: 'LineTo', y: this.i16(paramOff), x: this.i16(paramOff + 2), off };
      case 0x041B: return { type: 'Rectangle', bottom: this.i16(paramOff), right: this.i16(paramOff + 2), top: this.i16(paramOff + 4), left: this.i16(paramOff + 6), off };
      case 0x0418: return { type: 'Ellipse', bottom: this.i16(paramOff), right: this.i16(paramOff + 2), top: this.i16(paramOff + 4), left: this.i16(paramOff + 6), off };
      case 0x061C: return { type: 'RoundRect', rh: this.i16(paramOff), rw: this.i16(paramOff + 2), bottom: this.i16(paramOff + 4), right: this.i16(paramOff + 6), top: this.i16(paramOff + 8), left: this.i16(paramOff + 10), off };
      case 0x0817: return this.parseArc(paramOff, off);
      case 0x081A: return this.parsePie(paramOff, off);
      case 0x0830: return this.parseChord(paramOff, off);
      case 0x041F: return { type: 'SetPixel', color: this.parseColorRef(paramOff), y: this.i16(paramOff + 4), x: this.i16(paramOff + 6), off };
      case 0x0521: return this.parseTextOut(paramOff, off);
      case 0x0A32: return this.parseExtTextOut(paramOff, paramBytes, off);

      // Escape record
      case 0x0626: return this.parseEscape(paramOff, paramBytes, off);

      default:
        return { type: 'Unknown', func: '0x' + func.toString(16).padStart(4, '0'), size, off };
    }
  }

  parseColorRef(off) {
    return { r: this.u8(off), g: this.u8(off + 1), b: this.u8(off + 2) };
  }

  colorToCSS(c) {
    if (!c) return '#000000';
    return `#${c.r.toString(16).padStart(2,'0')}${c.g.toString(16).padStart(2,'0')}${c.b.toString(16).padStart(2,'0')}`;
  }

  parsePen(off, recOff) {
    return {
      type: 'CreatePen',
      penStyle: this.u16(off),
      width: this.i16(off + 2),
      color: this.parseColorRef(off + 6),
      off: recOff
    };
  }

  parseBrush(off, recOff) {
    return {
      type: 'CreateBrush',
      brushStyle: this.u16(off),
      color: this.parseColorRef(off + 2),
      hatch: this.u16(off + 6),
      off: recOff
    };
  }

  parseFont(off, paramBytes, recOff) {
    const rec = {
      type: 'CreateFont',
      height: this.i16(off),
      width: this.i16(off + 2),
      escapement: this.i16(off + 4),
      orientation: this.i16(off + 6),
      weight: this.i16(off + 8),
      italic: this.u8(off + 10),
      underline: this.u8(off + 11),
      strikeOut: this.u8(off + 12),
      charset: this.u8(off + 13),
      off: recOff
    };
    // Face name starts at offset 18 within parameters
    const nameBytes = [];
    for (let i = 18; i < paramBytes; i++) {
      const b = this.u8(off + i);
      if (b === 0) break;
      nameBytes.push(b);
    }
    rec.faceName = String.fromCharCode(...nameBytes);
    return rec;
  }

  parsePolygon(off, recOff) {
    const n = this.i16(off);
    const points = [];
    for (let i = 0; i < n; i++) {
      points.push({ x: this.i16(off + 2 + i * 4), y: this.i16(off + 4 + i * 4) });
    }
    return { type: 'Polygon', points, off: recOff };
  }

  parsePolyline(off, recOff) {
    const n = this.i16(off);
    const points = [];
    for (let i = 0; i < n; i++) {
      points.push({ x: this.i16(off + 2 + i * 4), y: this.i16(off + 4 + i * 4) });
    }
    return { type: 'Polyline', points, off: recOff };
  }

  parsePolyPolygon(off, recOff) {
    const nPolygons = this.u16(off);
    const counts = [];
    for (let i = 0; i < nPolygons; i++) {
      counts.push(this.u16(off + 2 + i * 2));
    }
    const pointsOff = off + 2 + nPolygons * 2;
    const polygons = [];
    let idx = 0;
    for (const count of counts) {
      const pts = [];
      for (let i = 0; i < count; i++) {
        pts.push({ x: this.i16(pointsOff + idx * 4), y: this.i16(pointsOff + idx * 4 + 2) });
        idx++;
      }
      polygons.push(pts);
    }
    return { type: 'PolyPolygon', polygons, off: recOff };
  }

  parseArc(off, recOff) {
    return {
      type: 'Arc',
      yEnd: this.i16(off), xEnd: this.i16(off + 2),
      yStart: this.i16(off + 4), xStart: this.i16(off + 6),
      bottom: this.i16(off + 8), right: this.i16(off + 10),
      top: this.i16(off + 12), left: this.i16(off + 14),
      off: recOff
    };
  }

  parsePie(off, recOff) {
    return {
      type: 'Pie',
      yEnd: this.i16(off), xEnd: this.i16(off + 2),
      yStart: this.i16(off + 4), xStart: this.i16(off + 6),
      bottom: this.i16(off + 8), right: this.i16(off + 10),
      top: this.i16(off + 12), left: this.i16(off + 14),
      off: recOff
    };
  }

  parseChord(off, recOff) {
    return {
      type: 'Chord',
      yEnd: this.i16(off), xEnd: this.i16(off + 2),
      yStart: this.i16(off + 4), xStart: this.i16(off + 6),
      bottom: this.i16(off + 8), right: this.i16(off + 10),
      top: this.i16(off + 12), left: this.i16(off + 14),
      off: recOff
    };
  }

  parseTextOut(off, recOff) {
    const len = this.i16(off);
    const strBytes = [];
    for (let i = 0; i < len; i++) {
      strBytes.push(this.u8(off + 2 + i));
    }
    const padLen = len + (len % 2); // pad to word boundary
    const y = this.i16(off + 2 + padLen);
    const x = this.i16(off + 4 + padLen);
    return { type: 'TextOut', text: String.fromCharCode(...strBytes), x, y, off: recOff };
  }

  parseExtTextOut(off, paramBytes, recOff) {
    const y = this.i16(off);
    const x = this.i16(off + 2);
    const len = this.i16(off + 4);
    const options = this.u16(off + 6);
    let strOff = off + 8;
    // If options has ETO_CLIPPED or ETO_OPAQUE, there's a rect (8 bytes)
    if (options & 0x0006) strOff += 8;
    const strBytes = [];
    for (let i = 0; i < len; i++) {
      strBytes.push(this.u8(strOff + i));
    }
    return { type: 'ExtTextOut', text: String.fromCharCode(...strBytes), x, y, off: recOff };
  }

  parseEscape(off, paramBytes, recOff) {
    const escFunc = this.u16(off);
    const byteCount = this.u16(off + 2);
    const dataOff = off + 4;

    // Check for MDCR records (custom metadata)
    if (byteCount >= 6) {
      const tag4 = String.fromCharCode(this.u8(dataOff), this.u8(dataOff+1), this.u8(dataOff+2), this.u8(dataOff+3));
      if (tag4 === 'MDCR') {
        return this.parseMDCR(dataOff, byteCount, recOff);
      }
    }

    return { type: 'Escape', escFunc: '0x' + escFunc.toString(16).padStart(4, '0'), byteCount, off: recOff };
  }

  parseMDCR(dataOff, byteCount, recOff) {
    // Read the tag string (printable ASCII characters)
    let tag = '';
    let i = 0;
    for (; i < byteCount && i < 10; i++) {
      const b = this.u8(dataOff + i);
      if (b >= 32 && b < 127) {
        tag += String.fromCharCode(b);
      } else {
        break;
      }
    }

    const baseTag = tag.trim();
    let subtype = null;
    let subtypeByte = null;

    // For MDCR-V records, check for subtype byte
    if (tag === 'MDCR-V' && i < byteCount) {
      subtypeByte = this.u8(dataOff + i);
      i++;
    }

    // Parse the rest of the data for V-type records
    let valueString = '';
    let regionId = null;
    let layerId = null;
    let filePath = '';
    let extraData = '';
    let rawHeaderBytes = null;

    if (baseTag.startsWith('MDCR-V') || (tag === 'MDCR-V' && subtypeByte !== null)) {
      // Skip null padding bytes
      while (i < byteCount && this.u8(dataOff + i) === 0) i++;

      // Read header fields: uint32, uint16, uint32
      if (i + 10 <= byteCount) {
        const field1 = this.u32(dataOff + i);
        const field2 = this.u16(dataOff + i + 4);
        const strByteCount = this.u32(dataOff + i + 6);
        rawHeaderBytes = { field1, field2, strByteCount };
        i += 10;

        // Read UTF-16LE string
        if (strByteCount > 0 && i + strByteCount <= byteCount) {
          const strBytes = new Uint8Array(this.bytes.buffer, dataOff + i, strByteCount);
          const decoder = new TextDecoder('utf-16le');
          valueString = decoder.decode(strBytes);

          // Parse the pipe-delimited format: " N| M|[path or extra]"
          const parts = valueString.split('|');
          if (parts.length >= 2) {
            regionId = parts[0].trim();
            layerId = parts[1].trim();
            if (parts.length >= 3) {
              const rest = parts.slice(2).join('|');
              if (rest.includes('\\') || rest.includes('/')) {
                filePath = rest;
              } else {
                extraData = rest;
              }
            }
          }
        }
      }
    }

    // Determine the full tag name
    let fullTag = baseTag;
    if (tag === 'MDCR-V' && subtypeByte !== null) {
      if (subtypeByte >= 32 && subtypeByte < 127) {
        fullTag = 'MDCR-V' + String.fromCharCode(subtypeByte);
      } else {
        fullTag = `MDCR-V(0x${subtypeByte.toString(16).padStart(2, '0')})`;
      }
    }

    const mdcr = {
      type: 'MDCR',
      tag: fullTag,
      baseTag,
      subtypeByte,
      regionId,
      layerId,
      filePath,
      extraData,
      valueString,
      rawHeaderBytes,
      off: recOff
    };

    this.mdcrRecords.push(mdcr);
    return mdcr;
  }
}


// ============================================================
// EMF Parser
// ============================================================

class EMFParser {
  constructor(buffer) {
    this.data = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
    this.offset = 0;
    this.log = [];
    this.records = [];
    this.mdcrRecords = [];
    this.placeable = null;
    this.header = null;
  }

  u8(off) { return this.data.getUint8(off); }
  u16(off) { return this.data.getUint16(off, true); }
  i16(off) { return this.data.getInt16(off, true); }
  u32(off) { return this.data.getUint32(off, true); }
  i32(off) { return this.data.getInt32(off, true); }

  info(msg) { this.log.push({ level: 'info', msg }); }
  warn(msg) { this.log.push({ level: 'warn', msg }); }
  error(msg) { this.log.push({ level: 'err', msg }); }

  parse() {
    this.parseHeader();
    this.parseRecords();
    return { placeable: this.placeable, header: this.header, records: this.records, mdcrRecords: this.mdcrRecords, log: this.log };
  }

  parseHeader() {
    const type = this.u32(0);
    const size = this.u32(4);
    if (type !== 1) { this.error('Not an EMF file'); return; }
    const bL = this.i32(8), bT = this.i32(12), bR = this.i32(16), bB = this.i32(20);
    const signature = this.u32(40);
    if (signature !== 0x464D4520) { this.error('Invalid EMF signature'); return; }
    const numRecords = this.u32(52);
    const numHandles = this.u16(56);
    this.placeable = { left: bL, top: bT, right: bR, bottom: bB, inch: 96 };
    this.header = { type: 1, headerSize: size / 2, version: this.u32(44), fileSize: this.u32(48) / 2, numObjects: numHandles, maxRecord: 0 };
    this.offset = size;
    this.info(`EMF: bounds=(${bL},${bT})-(${bR},${bB}), ${numRecords} records, ${numHandles} handles`);
  }

  parseRecords() {
    let safety = 0;
    while (this.offset + 8 <= this.data.byteLength && safety < 100000) {
      safety++;
      const recOff = this.offset;
      const recType = this.u32(recOff);
      const recSize = this.u32(recOff + 4);
      if (recSize < 8 || recOff + recSize > this.data.byteLength) { this.error(`Invalid record size ${recSize} at 0x${recOff.toString(16)}`); break; }
      const rec = this.parseRecord(recOff, recType, recSize);
      if (rec) {
        if (Array.isArray(rec)) this.records.push(...rec);
        else this.records.push(rec);
      }
      if (recType === 14) { this.info('EOF record reached'); break; }
      this.offset = recOff + recSize;
    }
    this.info(`Parsed ${this.records.length} records, ${this.mdcrRecords.length} MDCR metadata records`);
  }

  parseColorRef(off) {
    const val = this.u32(off);
    return { r: val & 0xFF, g: (val >> 8) & 0xFF, b: (val >> 16) & 0xFF };
  }

  parseRecord(off, type, size) {
    const d = off + 8;
    switch (type) {
      case 1: return null;
      case 14: return { type: 'EOF', off };
      case 9: return { type: 'SetWindowExt', w: this.i32(d), h: this.i32(d+4), off };
      case 10: return { type: 'SetWindowOrg', x: this.i32(d), y: this.i32(d+4), off };
      case 11: return { type: 'SetViewportExt', w: this.i32(d), h: this.i32(d+4), off };
      case 12: return { type: 'SetViewportOrg', x: this.i32(d), y: this.i32(d+4), off };
      case 17: return { type: 'SetMapMode', mode: this.u32(d), off };
      case 18: return { type: 'SetBkMode', mode: this.u32(d), off };
      case 19: return { type: 'SetPolyFillMode', mode: this.u32(d), off };
      case 20: return { type: 'SetROP2', mode: this.u32(d), off };
      case 22: return { type: 'SetTextAlign', align: this.u32(d), off };
      case 24: return { type: 'SetTextColor', color: this.parseColorRef(d), off };
      case 25: return { type: 'SetBkColor', color: this.parseColorRef(d), off };
      case 27: return { type: 'MoveTo', x: this.i32(d), y: this.i32(d+4), off };
      case 33: return { type: 'SaveDC', off };
      case 34: return { type: 'RestoreDC', dc: this.i32(d), off };
      case 13: case 21: case 30: case 67: case 75: return null;
      case 37: { const ih = this.u32(d); return (ih & 0x80000000) ? { type: 'SelectStockObject', stockId: ih, off } : { type: 'SelectObject', index: ih, off }; }
      case 38: return { type: 'CreatePen', emfIndex: this.u32(d), penStyle: this.u32(d+4), width: this.i32(d+8), color: this.parseColorRef(d+16), off };
      case 39: return { type: 'CreateBrush', emfIndex: this.u32(d), brushStyle: this.u32(d+4), color: this.parseColorRef(d+8), hatch: this.u32(d+12), off };
      case 40: return { type: 'DeleteObject', index: this.u32(d), off };
      case 82: return this.parseCreateFont(d, off);
      case 42: return { type: 'Ellipse', left: this.i32(d), top: this.i32(d+4), right: this.i32(d+8), bottom: this.i32(d+12), off };
      case 43: return { type: 'Rectangle', left: this.i32(d), top: this.i32(d+4), right: this.i32(d+8), bottom: this.i32(d+12), off };
      case 44: return { type: 'RoundRect', left: this.i32(d), top: this.i32(d+4), right: this.i32(d+8), bottom: this.i32(d+12), rw: this.i32(d+16), rh: this.i32(d+20), off };
      case 54: return { type: 'LineTo', x: this.i32(d), y: this.i32(d+4), off };
      case 86: return this.parsePoly16(d, off, 'Polygon');
      case 87: case 85: case 88: case 89: return this.parsePoly16(d, off, 'Polyline');
      case 91: return this.parsePolyPoly16(d, off, 'PolyPolygon');
      case 90: return this.parsePolyPoly16Lines(d, off);
      case 3: return this.parsePoly32(d, off, 'Polygon');
      case 4: return this.parsePoly32(d, off, 'Polyline');
      case 8: return this.parsePolyPoly32(d, off);
      case 59: return { type: 'BeginPath', off };
      case 60: return { type: 'EndPath', off };
      case 61: return { type: 'CloseFigure', off };
      case 62: return { type: 'FillPath', off };
      case 63: return { type: 'StrokeAndFillPath', off };
      case 64: return { type: 'StrokePath', off };
      case 84: return this.parseExtTextOutW(d, off);
      case 70: return this.parseComment(d, off);
      default: return { type: 'Unknown', func: '0x' + type.toString(16).padStart(4,'0'), size, off };
    }
  }

  parseCreateFont(d, off) {
    const ih = this.u32(d);
    const height = this.i32(d+4), weight = this.i32(d+20);
    const italic = this.u8(d+24), underline = this.u8(d+25), strikeOut = this.u8(d+26), charset = this.u8(d+27);
    let faceName = '';
    const nameOff = d + 68;
    for (let i = 0; i < 32 && nameOff+i*2+1 < this.data.byteLength; i++) {
      const ch = this.u16(nameOff + i*2); if (ch === 0) break;
      faceName += String.fromCharCode(ch);
    }
    return { type: 'CreateFont', emfIndex: ih, height, width: 0, escapement: 0, orientation: 0, weight, italic, underline, strikeOut, charset, faceName, off };
  }

  parsePoly16(d, off, polyType) {
    const count = this.u32(d+16); const points = []; const p = d+20;
    for (let i = 0; i < count; i++) points.push({ x: this.i16(p+i*4), y: this.i16(p+i*4+2) });
    return { type: polyType, points, off };
  }

  parsePoly32(d, off, polyType) {
    const count = this.u32(d+16); const points = []; const p = d+20;
    for (let i = 0; i < count; i++) points.push({ x: this.i32(p+i*8), y: this.i32(p+i*8+4) });
    return { type: polyType, points, off };
  }

  parsePolyPoly16(d, off) {
    const nP = this.u32(d+16); const counts = [];
    for (let i = 0; i < nP; i++) counts.push(this.u32(d+24+i*4));
    const p = d + 24 + nP*4; const polygons = []; let idx = 0;
    for (const c of counts) { const pts = []; for (let i = 0; i < c; i++) { pts.push({ x: this.i16(p+idx*4), y: this.i16(p+idx*4+2) }); idx++; } polygons.push(pts); }
    return { type: 'PolyPolygon', polygons, off };
  }

  parsePolyPoly16Lines(d, off) {
    const nP = this.u32(d+16); const counts = [];
    for (let i = 0; i < nP; i++) counts.push(this.u32(d+24+i*4));
    const p = d + 24 + nP*4; const results = []; let idx = 0;
    for (const c of counts) { const pts = []; for (let i = 0; i < c; i++) { pts.push({ x: this.i16(p+idx*4), y: this.i16(p+idx*4+2) }); idx++; } results.push({ type: 'Polyline', points: pts, off }); }
    return results;
  }

  parsePolyPoly32(d, off) {
    const nP = this.u32(d+16); const counts = [];
    for (let i = 0; i < nP; i++) counts.push(this.u32(d+24+i*4));
    const p = d + 24 + nP*4; const polygons = []; let idx = 0;
    for (const c of counts) { const pts = []; for (let i = 0; i < c; i++) { pts.push({ x: this.i32(p+idx*8), y: this.i32(p+idx*8+4) }); idx++; } polygons.push(pts); }
    return { type: 'PolyPolygon', polygons, off };
  }

  parseExtTextOutW(d, off) {
    const x = this.i32(d+28), y = this.i32(d+32), chars = this.u32(d+36), offStr = this.u32(d+40);
    if (chars === 0) return null;
    let text = ''; const s = off + offStr;
    for (let i = 0; i < chars && s+i*2+1 < this.data.byteLength; i++) { const ch = this.u16(s+i*2); if (ch === 0) break; text += String.fromCharCode(ch); }
    return { type: 'ExtTextOut', text, x, y, off };
  }

  parseComment(d, off) {
    const dataSize = this.u32(d); const dataOff = d + 4;
    if (dataSize >= 6) {
      const tag4 = String.fromCharCode(this.u8(dataOff), this.u8(dataOff+1), this.u8(dataOff+2), this.u8(dataOff+3));
      if (tag4 === 'MDCR') return this.parseMDCR(dataOff, dataSize, off);
    }
    return null;
  }

  parseMDCR(dataOff, byteCount, recOff) {
    let tag = ''; let i = 0;
    for (; i < byteCount && i < 10; i++) { const b = this.u8(dataOff+i); if (b >= 32 && b < 127) tag += String.fromCharCode(b); else break; }
    const baseTag = tag.trim(); let subtypeByte = null;
    if (tag === 'MDCR-V' && i < byteCount) { subtypeByte = this.u8(dataOff+i); i++; }
    let valueString = '', regionId = null, layerId = null, filePath = '', extraData = '', rawHeaderBytes = null;
    if (baseTag.startsWith('MDCR-V') || (tag === 'MDCR-V' && subtypeByte !== null)) {
      while (i < byteCount && this.u8(dataOff+i) === 0) i++;
      if (i + 10 <= byteCount) {
        const field1 = this.u32(dataOff+i), field2 = this.u16(dataOff+i+4), strByteCount = this.u32(dataOff+i+6);
        rawHeaderBytes = { field1, field2, strByteCount }; i += 10;
        if (strByteCount > 0 && i + strByteCount <= byteCount) {
          valueString = new TextDecoder('utf-16le').decode(new Uint8Array(this.bytes.buffer, dataOff+i, strByteCount));
          const parts = valueString.split('|');
          if (parts.length >= 2) { regionId = parts[0].trim(); layerId = parts[1].trim();
            if (parts.length >= 3) { const rest = parts.slice(2).join('|'); if (rest.includes('\\') || rest.includes('/')) filePath = rest; else extraData = rest; }
          }
        }
      }
    }
    let fullTag = baseTag;
    if (tag === 'MDCR-V' && subtypeByte !== null) { fullTag = (subtypeByte >= 32 && subtypeByte < 127) ? 'MDCR-V' + String.fromCharCode(subtypeByte) : `MDCR-V(0x${subtypeByte.toString(16).padStart(2,'0')})`; }
    const mdcr = { type: 'MDCR', tag: fullTag, baseTag, subtypeByte, regionId, layerId, filePath, extraData, valueString, rawHeaderBytes, off: recOff };
    this.mdcrRecords.push(mdcr);
    return mdcr;
  }
}


// ============================================================
// SVG Renderer
// ============================================================

class SVGRenderer {
  constructor(parsed) {
    this.parsed = parsed;
    this.objectTable = new Array(parsed.header.numObjects).fill(null);
    this.currentPen = { style: 0, width: 0, color: { r: 0, g: 0, b: 0 } };
    this.currentBrush = { style: 0, color: { r: 255, g: 255, b: 255 }, hatch: 0 };
    this.currentFont = null;
    this.textColor = { r: 0, g: 0, b: 0 };
    this.textAlign = 0;
    this.windowOrg = { x: 0, y: 0 };
    this.windowExt = { w: 1, h: 1 };
    this.bkMode = 2; // OPAQUE
    this.polyFillMode = 1; // ALTERNATE
    this.groupStack = [];
    this.currentGroup = null;
    this.lastClosedGroup = null;
    this.svgElements = [];
    this.mdcrIndex = 0;
    this.pathCommands = [];
    this.inPath = false;
    this.curPos = { x: 0, y: 0 };
    this.shapeIndex = 0;
  }

  colorToCSS(c) {
    if (!c) return '#000000';
    return `#${c.r.toString(16).padStart(2,'0')}${c.g.toString(16).padStart(2,'0')}${c.b.toString(16).padStart(2,'0')}`;
  }

  findNextFreeSlot() {
    for (let i = 0; i < this.objectTable.length; i++) {
      if (this.objectTable[i] === null) return i;
    }
    return -1;
  }

  render() {
    const p = this.parsed.placeable;

    // Process all records first so we discover SetWindowOrg/Ext
    for (const rec of this.parsed.records) {
      this.processRecord(rec);
    }

    // Use the logical window coordinates for the viewBox
    let viewBox, width, height;
    const wx = this.windowOrg.x;
    const wy = this.windowOrg.y;
    const ww = this.windowExt.w;
    const wh = this.windowExt.h;

    if (ww > 1 && wh > 1) {
      viewBox = `${wx} ${wy} ${ww} ${wh}`;
      width = ww;
      height = wh;
    } else if (p) {
      viewBox = `${p.left} ${p.top} ${p.right - p.left} ${p.bottom - p.top}`;
      width = p.right - p.left;
      height = p.bottom - p.top;
    } else {
      viewBox = '0 0 1000 1000';
      width = 1000;
      height = 1000;
    }

    // Build SVG string
    const svgNS = 'http://www.w3.org/2000/svg';
    const mdcrNS = 'http://sensory.com/mdcr';

    let svg = `<svg xmlns="${svgNS}" xmlns:mdcr="${mdcrNS}" viewBox="${viewBox}" width="${width}" height="${height}">\n`;

    // Metadata block with all MDCR information
    svg += `  <metadata>\n`;
    svg += `    <mdcr:info xmlns:mdcr="${mdcrNS}">\n`;
    svg += `      <mdcr:source format="WMF" generator="wmf2svg.js"/>\n`;
    if (p) {
      svg += `      <mdcr:bounds left="${p.left}" top="${p.top}" right="${p.right}" bottom="${p.bottom}" inch="${p.inch}"/>\n`;
    }
    svg += `      <mdcr:records count="${this.parsed.mdcrRecords.length}">\n`;
    for (const m of this.parsed.mdcrRecords) {
      svg += `        <mdcr:record tag="${this.escXml(m.tag)}"`;
      if (m.regionId !== null) svg += ` region="${this.escXml(m.regionId)}"`;
      if (m.layerId !== null) svg += ` layer="${this.escXml(m.layerId)}"`;
      if (m.filePath) svg += ` file="${this.escXml(m.filePath)}"`;
      if (m.extraData) svg += ` extra="${this.escXml(m.extraData)}"`;
      if (m.valueString) svg += ` value="${this.escXml(m.valueString)}"`;
      svg += `/>\n`;
    }
    svg += `      </mdcr:records>\n`;
    svg += `    </mdcr:info>\n`;
    svg += `  </metadata>\n`;

    // Render elements
    svg += this.renderElements(this.svgElements, 1);

    // Close any remaining open groups
    svg += `</svg>`;
    return svg;
  }

  renderElements(elements, depth) {
    let svg = '';
    const indent = '  '.repeat(depth);
    for (const el of elements) {
      if (el.type === 'group') {
        svg += `${indent}<g`;
        if (el.attrs) {
          for (const [k, v] of Object.entries(el.attrs)) {
            svg += ` ${k}="${this.escXml(String(v))}"`;
          }
        }
        svg += `>\n`;
        if (el.children) {
          svg += this.renderElements(el.children, depth + 1);
        }
        svg += `${indent}</g>\n`;
      } else if (el.type === 'polygon') {
        svg += `${indent}<polygon points="${el.points}" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"`;
        if (el.fillRule) svg += ` fill-rule="${el.fillRule}"`;
        if (el.strokeDasharray) svg += ` stroke-dasharray="${el.strokeDasharray}"`;
        if (el.dataShape != null) svg += ` data-shape="${el.dataShape}"`;
        if (el.attrs) {
          for (const [k, v] of Object.entries(el.attrs)) {
            svg += ` ${k}="${this.escXml(String(v))}"`;
          }
        }
        svg += `/>\n`;
      } else if (el.type === 'polyline') {
        svg += `${indent}<polyline points="${el.points}" fill="none" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"`;
        if (el.strokeDasharray) svg += ` stroke-dasharray="${el.strokeDasharray}"`;
        svg += `/>\n`;
      } else if (el.type === 'rect') {
        svg += `${indent}<rect x="${el.x}" y="${el.y}" width="${el.w}" height="${el.h}" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"`;
        if (el.dataShape != null) svg += ` data-shape="${el.dataShape}"`;
        svg += `/>\n`;
      } else if (el.type === 'ellipse') {
        svg += `${indent}<ellipse cx="${el.cx}" cy="${el.cy}" rx="${el.rx}" ry="${el.ry}" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"`;
        if (el.dataShape != null) svg += ` data-shape="${el.dataShape}"`;
        svg += `/>\n`;
      } else if (el.type === 'line') {
        svg += `${indent}<line x1="${el.x1}" y1="${el.y1}" x2="${el.x2}" y2="${el.y2}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"/>\n`;
      } else if (el.type === 'text') {
        svg += `${indent}<text x="${el.x}" y="${el.y}" fill="${el.fill}" font-size="${el.fontSize}"`;
        if (el.fontFamily) svg += ` font-family="${this.escXml(el.fontFamily)}"`;
        if (el.fontWeight) svg += ` font-weight="${el.fontWeight}"`;
        if (el.fontStyle) svg += ` font-style="${el.fontStyle}"`;
        if (el.textAnchor) svg += ` text-anchor="${el.textAnchor}"`;
        if (el.dominantBaseline) svg += ` dominant-baseline="${el.dominantBaseline}"`;
        svg += `>${this.escXml(el.text)}</text>\n`;
      } else if (el.type === 'path') {
        svg += `${indent}<path d="${el.d}" fill="${el.fill}" stroke="${el.stroke}" stroke-width="${el.strokeWidth}"`;
        if (el.fillRule) svg += ` fill-rule="${el.fillRule}"`;
        if (el.dataShape != null) svg += ` data-shape="${el.dataShape}"`;
        svg += `/>\n`;
      } else if (el.type === 'comment') {
        svg += `${indent}<!-- ${this.escXml(el.text)} -->\n`;
      }
    }
    return svg;
  }

  escXml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  getCurrentContainer() {
    if (this.groupStack.length > 0) {
      return this.groupStack[this.groupStack.length - 1].children;
    }
    return this.svgElements;
  }

  pushElement(el) {
    this.getCurrentContainer().push(el);
  }

  getStrokeProps() {
    const penStyle = this.currentPen.style & 0x0F;
    const strokeColor = this.colorToCSS(this.currentPen.color);
    const strokeWidth = Math.max(this.currentPen.width, 1);
    let strokeDasharray = null;

    if (penStyle === 5) { // PS_NULL
      return { stroke: 'none', strokeWidth: 0, strokeDasharray: null };
    }

    switch (penStyle) {
      case 1: strokeDasharray = `${strokeWidth * 4},${strokeWidth * 2}`; break; // DASH
      case 2: strokeDasharray = `${strokeWidth},${strokeWidth * 2}`; break; // DOT
      case 3: strokeDasharray = `${strokeWidth * 4},${strokeWidth * 2},${strokeWidth},${strokeWidth * 2}`; break; // DASHDOT
      case 4: strokeDasharray = `${strokeWidth * 4},${strokeWidth * 2},${strokeWidth},${strokeWidth * 2},${strokeWidth},${strokeWidth * 2}`; break; // DASHDOTDOT
    }

    return { stroke: strokeColor, strokeWidth, strokeDasharray };
  }

  getFillProps() {
    if (this.currentBrush.style === 1) { // BS_NULL
      return { fill: 'none' };
    }
    return { fill: this.colorToCSS(this.currentBrush.color) };
  }

  processRecord(rec) {
    switch (rec.type) {
      case 'SetMapMode':
        break;
      case 'SetBkMode':
        this.bkMode = rec.mode;
        break;
      case 'SetPolyFillMode':
        this.polyFillMode = rec.mode;
        break;
      case 'SetWindowOrg':
        this.windowOrg = { x: rec.x, y: rec.y };
        break;
      case 'SetWindowExt':
        this.windowExt = { w: rec.w, h: rec.h };
        break;
      case 'SetROP2':
      case 'SetBkColor':
        break;
      case 'SetTextColor':
        this.textColor = rec.color;
        break;
      case 'SetTextAlign':
        this.textAlign = rec.align;
        break;
      case 'SaveDC':
      case 'RestoreDC':
        break;

      case 'CreatePen': {
        const slot = (rec.emfIndex != null) ? rec.emfIndex : this.findNextFreeSlot();
        if (slot >= 0 && slot < this.objectTable.length) {
          this.objectTable[slot] = { type: 'pen', style: rec.penStyle, width: rec.width, color: rec.color };
        }
        break;
      }
      case 'CreateBrush': {
        const slot = (rec.emfIndex != null) ? rec.emfIndex : this.findNextFreeSlot();
        if (slot >= 0 && slot < this.objectTable.length) {
          this.objectTable[slot] = { type: 'brush', style: rec.brushStyle, color: rec.color, hatch: rec.hatch };
        }
        break;
      }
      case 'CreateFont': {
        const slot = (rec.emfIndex != null) ? rec.emfIndex : this.findNextFreeSlot();
        if (slot >= 0 && slot < this.objectTable.length) {
          this.objectTable[slot] = { type: 'font', height: rec.height, weight: rec.weight, italic: rec.italic, faceName: rec.faceName };
        }
        break;
      }

      case 'SelectStockObject': {
        const id = rec.stockId & 0x7FFFFFFF;
        const stockBrushes = {
          0: { type: 'brush', style: 0, color: {r:255,g:255,b:255}, hatch: 0 },
          1: { type: 'brush', style: 0, color: {r:192,g:192,b:192}, hatch: 0 },
          2: { type: 'brush', style: 0, color: {r:128,g:128,b:128}, hatch: 0 },
          3: { type: 'brush', style: 0, color: {r:64,g:64,b:64}, hatch: 0 },
          4: { type: 'brush', style: 0, color: {r:0,g:0,b:0}, hatch: 0 },
          5: { type: 'brush', style: 1, color: {r:0,g:0,b:0}, hatch: 0 },
        };
        const stockPens = {
          6: { type: 'pen', style: 0, width: 1, color: {r:255,g:255,b:255} },
          7: { type: 'pen', style: 0, width: 1, color: {r:0,g:0,b:0} },
          8: { type: 'pen', style: 5, width: 0, color: {r:0,g:0,b:0} },
        };
        if (stockBrushes[id]) this.currentBrush = stockBrushes[id];
        else if (stockPens[id]) this.currentPen = stockPens[id];
        break;
      }

      case 'SelectObject': {
        const obj = this.objectTable[rec.index];
        if (obj) {
          if (obj.type === 'pen') this.currentPen = obj;
          else if (obj.type === 'brush') this.currentBrush = obj;
          else if (obj.type === 'font') this.currentFont = obj;
        }
        break;
      }
      case 'DeleteObject':
        this.objectTable[rec.index] = null;
        break;

      case 'Polygon': {
        if (this.inPath) {
          const pts = rec.points;
          if (pts.length > 0) {
            this.pathCommands.push(`M${pts[0].x},${pts[0].y}`);
            for (let i = 1; i < pts.length; i++) this.pathCommands.push(`L${pts[i].x},${pts[i].y}`);
            this.pathCommands.push('Z');
          }
        } else {
          const pts = rec.points.map(p => `${p.x},${p.y}`).join(' ');
          const { stroke, strokeWidth, strokeDasharray } = this.getStrokeProps();
          const { fill } = this.getFillProps();
          const fillRule = this.polyFillMode === 1 ? 'evenodd' : 'nonzero';
          const el = { type: 'polygon', points: pts, fill, stroke, strokeWidth, strokeDasharray, fillRule };
          if (fill !== 'none') el.dataShape = this.shapeIndex++;
          this.pushElement(el);
        }
        break;
      }

      case 'Polyline': {
        if (this.inPath) {
          const pts = rec.points;
          if (pts.length > 0) {
            this.pathCommands.push(`M${pts[0].x},${pts[0].y}`);
            for (let i = 1; i < pts.length; i++) this.pathCommands.push(`L${pts[i].x},${pts[i].y}`);
          }
        } else {
          const pts = rec.points.map(p => `${p.x},${p.y}`).join(' ');
          const { stroke, strokeWidth, strokeDasharray } = this.getStrokeProps();
          this.pushElement({ type: 'polyline', points: pts, stroke, strokeWidth, strokeDasharray });
        }
        break;
      }

      case 'PolyPolygon': {
        const { stroke, strokeWidth, strokeDasharray } = this.getStrokeProps();
        const { fill } = this.getFillProps();
        const fillRule = this.polyFillMode === 1 ? 'evenodd' : 'nonzero';
        let d = '';
        for (const poly of rec.polygons) {
          if (poly.length > 0) {
            d += `M${poly[0].x},${poly[0].y}`;
            for (let i = 1; i < poly.length; i++) {
              d += `L${poly[i].x},${poly[i].y}`;
            }
            d += 'Z ';
          }
        }
        const el = { type: 'path', d: d.trim(), fill, stroke, strokeWidth, fillRule };
        if (fill !== 'none') el.dataShape = this.shapeIndex++;
        this.pushElement(el);
        break;
      }

      case 'Rectangle': {
        const { stroke, strokeWidth } = this.getStrokeProps();
        const { fill } = this.getFillProps();
        const el = {
          type: 'rect',
          x: rec.left, y: rec.top,
          w: rec.right - rec.left, h: rec.bottom - rec.top,
          fill, stroke, strokeWidth
        };
        if (fill !== 'none') el.dataShape = this.shapeIndex++;
        this.pushElement(el);
        break;
      }

      case 'Ellipse': {
        const { stroke, strokeWidth } = this.getStrokeProps();
        const { fill } = this.getFillProps();
        const cx = (rec.left + rec.right) / 2;
        const cy = (rec.top + rec.bottom) / 2;
        const rx = (rec.right - rec.left) / 2;
        const ry = (rec.bottom - rec.top) / 2;
        const el = { type: 'ellipse', cx, cy, rx, ry, fill, stroke, strokeWidth };
        if (fill !== 'none') el.dataShape = this.shapeIndex++;
        this.pushElement(el);
        break;
      }

      case 'RoundRect': {
        const { stroke, strokeWidth } = this.getStrokeProps();
        const { fill } = this.getFillProps();
        const el = {
          type: 'rect',
          x: rec.left, y: rec.top,
          w: rec.right - rec.left, h: rec.bottom - rec.top,
          fill, stroke, strokeWidth
        };
        if (fill !== 'none') el.dataShape = this.shapeIndex++;
        this.pushElement(el);
        break;
      }

      case 'TextOut':
      case 'ExtTextOut': {
        const fontSize = this.currentFont ? Math.abs(this.currentFont.height) : 12;
        const fontFamily = this.currentFont ? this.currentFont.faceName : '';
        const fontWeight = (this.currentFont && this.currentFont.weight >= 700) ? 'bold' : 'normal';
        const fontStyle = (this.currentFont && this.currentFont.italic) ? 'italic' : 'normal';
        const fill = this.colorToCSS(this.textColor);
        // Text alignment from SetTextAlign
        let textAnchor = 'start';
        let dominantBaseline = 'auto';
        if (this.textAlign & 0x0006) textAnchor = 'end'; // TA_RIGHT
        if (this.textAlign & 0x0001) textAnchor = 'middle'; // TA_CENTER
        this.pushElement({
          type: 'text',
          x: rec.x, y: rec.y,
          text: rec.text,
          fill,
          fontSize,
          fontFamily: fontFamily || undefined,
          fontWeight: fontWeight !== 'normal' ? fontWeight : undefined,
          fontStyle: fontStyle !== 'normal' ? fontStyle : undefined,
          textAnchor: textAnchor !== 'start' ? textAnchor : undefined,
          dominantBaseline: dominantBaseline !== 'auto' ? dominantBaseline : undefined
        });
        break;
      }

      case 'Arc':
      case 'Pie':
      case 'Chord': {
        const d = this.buildArcPath(rec);
        const { stroke, strokeWidth } = this.getStrokeProps();
        const { fill } = this.getFillProps();
        const actualFill = rec.type === 'Arc' ? 'none' : fill;
        const el = { type: 'path', d, fill: actualFill, stroke, strokeWidth };
        if (actualFill !== 'none') el.dataShape = this.shapeIndex++;
        this.pushElement(el);
        break;
      }

      case 'MoveTo':
        this.curPos = { x: rec.x, y: rec.y };
        if (this.inPath) this.pathCommands.push(`M${rec.x},${rec.y}`);
        break;

      case 'LineTo': {
        if (this.inPath) {
          this.pathCommands.push(`L${rec.x},${rec.y}`);
        } else {
          const { stroke, strokeWidth } = this.getStrokeProps();
          this.pushElement({ type: 'line', x1: this.curPos.x, y1: this.curPos.y, x2: rec.x, y2: rec.y, stroke, strokeWidth });
        }
        this.curPos = { x: rec.x, y: rec.y };
        break;
      }

      case 'BeginPath':
        this.inPath = true;
        this.pathCommands = [];
        break;
      case 'EndPath':
        this.inPath = false;
        break;
      case 'CloseFigure':
        if (this.inPath) this.pathCommands.push('Z');
        break;
      case 'FillPath': {
        if (this.pathCommands.length > 0) {
          const { fill } = this.getFillProps();
          const fillRule = this.polyFillMode === 1 ? 'evenodd' : 'nonzero';
          const el = { type: 'path', d: this.pathCommands.join(' '), fill, stroke: 'none', strokeWidth: 0, fillRule };
          if (fill !== 'none') el.dataShape = this.shapeIndex++;
          this.pushElement(el);
        }
        this.pathCommands = [];
        break;
      }
      case 'StrokePath': {
        if (this.pathCommands.length > 0) {
          const { stroke, strokeWidth } = this.getStrokeProps();
          this.pushElement({ type: 'path', d: this.pathCommands.join(' '), fill: 'none', stroke, strokeWidth });
        }
        this.pathCommands = [];
        break;
      }
      case 'StrokeAndFillPath': {
        if (this.pathCommands.length > 0) {
          const { stroke, strokeWidth } = this.getStrokeProps();
          const { fill } = this.getFillProps();
          const fillRule = this.polyFillMode === 1 ? 'evenodd' : 'nonzero';
          const el = { type: 'path', d: this.pathCommands.join(' '), fill, stroke, strokeWidth, fillRule };
          if (fill !== 'none') el.dataShape = this.shapeIndex++;
          this.pushElement(el);
        }
        this.pathCommands = [];
        break;
      }

      // MDCR metadata records
      case 'MDCR': {
        this.processMDCR(rec);
        break;
      }
    }
  }

  buildArcPath(rec) {
    const cx = (rec.left + rec.right) / 2;
    const cy = (rec.top + rec.bottom) / 2;
    const rx = (rec.right - rec.left) / 2;
    const ry = (rec.bottom - rec.top) / 2;

    const startAngle = Math.atan2(-(rec.yStart - cy) / ry, (rec.xStart - cx) / rx);
    const endAngle = Math.atan2(-(rec.yEnd - cy) / ry, (rec.xEnd - cx) / rx);

    const x1 = cx + rx * Math.cos(startAngle);
    const y1 = cy - ry * Math.sin(startAngle);
    const x2 = cx + rx * Math.cos(endAngle);
    const y2 = cy - ry * Math.sin(endAngle);

    let sweep = startAngle - endAngle;
    if (sweep < 0) sweep += 2 * Math.PI;
    const largeArc = sweep > Math.PI ? 1 : 0;

    let d = `M${x1.toFixed(1)},${y1.toFixed(1)} A${rx},${ry} 0 ${largeArc} 0 ${x2.toFixed(1)},${y2.toFixed(1)}`;

    if (rec.type === 'Pie') {
      d += ` L${cx},${cy} Z`;
    } else if (rec.type === 'Chord') {
      d += ' Z';
    }

    return d;
  }

  processMDCR(rec) {
    const tag = rec.tag;

    if (tag === 'MDCR-{') {
      // Open a new group
      const group = {
        type: 'group',
        attrs: {
          'data-mdcr': 'group',
          'class': 'mdcr-region'
        },
        children: []
      };
      this.pushElement(group);
      this.groupStack.push(group);
      this.lastClosedGroup = null; // reset on new group open

    } else if (tag === 'MDCR-}') {
      // Close current group, remember it for subsequent V records
      if (this.groupStack.length > 0) {
        this.lastClosedGroup = this.groupStack.pop();
      }

    } else if (tag === 'MDCR-S' || tag === 'MDCR-S ') {
      // State separator - clear lastClosedGroup as we've moved past it
      this.lastClosedGroup = null;

    } else if (tag.startsWith('MDCR-V')) {
      // Value record - attach metadata to the best target:
      // 1. The most recently closed group (MDCR-V often follows MDCR-})
      // 2. The current open group
      // 3. A standalone annotation group
      const attrs = {};
      if (rec.regionId !== null) attrs['data-mdcr-region'] = rec.regionId;
      if (rec.layerId !== null) attrs['data-mdcr-layer'] = rec.layerId;
      if (rec.filePath) attrs['data-mdcr-sound'] = rec.filePath;
      if (rec.extraData) attrs['data-mdcr-extra'] = rec.extraData;
      attrs['data-mdcr-tag'] = tag;
      if (rec.valueString) attrs['data-mdcr-value'] = rec.valueString;

      if (this.lastClosedGroup) {
        // Attach to the group that just closed (most common pattern)
        Object.assign(this.lastClosedGroup.attrs, attrs);
      } else if (this.groupStack.length > 0) {
        // Inside an open group — try to wrap the most recently drawn shape.
        // In VB6 MDraw WMFs, the pattern is: [shape drawn] → MDCR-V (metadata) → MDCR-S
        const container = this.groupStack[this.groupStack.length - 1].children;
        let wrapped = false;
        for (let i = container.length - 1; i >= 0; i--) {
          const child = container[i];
          if (child.type !== 'group') {
            // Wrap this shape in a <g> with the MDCR attrs
            const wrapper = {
              type: 'group',
              attrs: { ...attrs, 'data-mdcr': 'group', 'class': 'mdcr-region' },
              children: [child]
            };
            container[i] = wrapper;
            wrapped = true;
            break;
          }
        }
        if (!wrapped) {
          // No shape to wrap — apply to the group itself (group-level metadata)
          const group = this.groupStack[this.groupStack.length - 1];
          Object.assign(group.attrs, attrs);
        }
      } else {
        // Standalone annotation (no group context)
        this.pushElement({
          type: 'group',
          attrs: { ...attrs, 'data-mdcr': 'annotation' },
          children: []
        });
      }
    }
  }
}

// ============================================================
// Helper: load WMF/EMF file and return SVG string
// ============================================================

async function wmfToSvg(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const isEMF = (magic === 1 && buf.byteLength >= 44 && dv.getUint32(40, true) === 0x464D4520);
  const parser = isEMF ? new EMFParser(buf) : new WMFParser(buf);
  const parsed = parser.parse();
  const renderer = new SVGRenderer(parsed);
  return renderer.render();
}

// ============================================================
// Helper: load WMF/EMF and return parsed data + SVG elements
// (for apps that need access to MDCR metadata)
// ============================================================

async function wmfParse(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  const isEMF = (magic === 1 && buf.byteLength >= 44 && dv.getUint32(40, true) === 0x464D4520);
  const parser = isEMF ? new EMFParser(buf) : new WMFParser(buf);
  const parsed = parser.parse();
  const renderer = new SVGRenderer(parsed);
  const svg = renderer.render();
  return { parsed, svg, mdcrRecords: parsed.mdcrRecords };
}
