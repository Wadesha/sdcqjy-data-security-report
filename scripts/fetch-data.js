#!/usr/bin/env node
/**
 * 多省份产权交易数据获取脚本
 * 从山东、广州、深圳、江西、陕西等交易所获取项目数据，生成 d.html
 *
 * 使用方式: node scripts/fetch-data.js
 * 环境要求: Node.js 18+
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const tls = require('tls');
const net = require('net');

const OUTPUT_FILE = path.join(__dirname, '..', 'd.html');
const HISTORY_FILE = path.join(__dirname, '..', 'history.json');

// ============================================================
// 代理支持
// ============================================================

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || '';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * 建立 TCP socket（通过代理或直连）
 * - 有代理：HTTP 目标 → net.connect 到代理；HTTPS 目标 → CONNECT 隧道 + TLS
 * - 无代理：net.connect 到目标
 */
function createSocket(targetUrl) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const isHttps = u.protocol === 'https:';
    const port = u.port || (isHttps ? 443 : 80);
    const timeout = setTimeout(() => reject(new Error('socket timeout')), 15000);

    if (!PROXY_URL) {
      const socket = net.connect(port, u.hostname);
      socket.on('connect', () => { clearTimeout(timeout); resolve(socket); });
      socket.on('error', e => { clearTimeout(timeout); reject(e); });
      return;
    }

    const proxy = new URL(PROXY_URL);
    const proxyPort = proxy.port || 80;

    if (!isHttps) {
      const socket = net.connect(proxyPort, proxy.hostname);
      socket.on('connect', () => { clearTimeout(timeout); resolve(socket); });
      socket.on('error', e => { clearTimeout(timeout); reject(e); });
      return;
    }

    // HTTPS: CONNECT 隧道
    const connectReq = http.request({
      hostname: proxy.hostname, port: proxyPort,
      method: 'CONNECT', path: `${u.hostname}:${port}`,
      headers: { Host: `${u.hostname}:${port}` },
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { clearTimeout(timeout); reject(new Error(`CONNECT failed: ${res.statusCode}`)); return; }
      const tlsSocket = tls.connect({ socket, servername: u.hostname, rejectUnauthorized: false }, () => {
        clearTimeout(timeout);
        resolve(tlsSocket);
      });
      tlsSocket.on('error', e => { clearTimeout(timeout); reject(e); });
    });
    connectReq.on('error', e => { clearTimeout(timeout); reject(e); });
    connectReq.end();
  });
}

/**
 * 在 socket 上发送原始 HTTP 请求并读取响应
 * - 代理模式：HTTP 用绝对 URL；HTTPS/TLS 用相对路径
 */
function rawRequest(socket, method, fullUrl, body, hostname, contentType) {
  return new Promise((resolve, reject) => {
    const u = new URL(fullUrl);
    const isTls = socket instanceof tls.TLSSocket;
    const reqPath = (PROXY_URL && !isTls) ? fullUrl : (u.pathname + u.search);
    const host = hostname || u.hostname;

    let reqLines = [
      `${method} ${reqPath} HTTP/1.1`,
      `Host: ${host}`,
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Connection: close',
    ];
    if (body) {
      reqLines.push(`Content-Type: ${contentType || 'application/x-www-form-urlencoded'}`);
      reqLines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    }
    socket.write(reqLines.join('\r\n') + '\r\n\r\n');
    if (body) socket.write(body);

    let chunks = [];
    socket.on('data', c => chunks.push(c));
    socket.on('end', () => {
      const buf = Buffer.concat(chunks);
      // 二进制安全地查找 header/body 分隔
      const sep = Buffer.from('\r\n\r\n');
      let headerEnd = -1;
      for (let i = 0; i <= buf.length - sep.length; i++) {
        if (buf.compare(sep, 0, sep.length, i, i + sep.length) === 0) { headerEnd = i; break; }
      }
      if (headerEnd < 0) { resolve(''); return; }

      const header = buf.slice(0, headerEnd).toString('ascii');
      const statusCode = parseInt(header.split(' ')[1]) || 0;
      let bodyBuf = buf.slice(headerEnd + 4);

      // chunked
      if (/transfer-encoding:\s*chunked/i.test(header)) {
        bodyBuf = dechunkBuf(bodyBuf);
      }

      // gzip
      if (/content-encoding:\s*gzip/i.test(header)) {
        try { bodyBuf = require('zlib').gunzipSync(bodyBuf); } catch (e) { /* ignore */ }
      }

      // 重定向
      if (statusCode >= 300 && statusCode < 400) {
        const locMatch = header.match(/location:\s*(.+?)\r\n/i);
        if (locMatch) {
          let loc = locMatch[1].trim();
          if (loc.startsWith('/')) loc = u.protocol + '//' + u.hostname + loc;
          socket.destroy();
          httpGet(loc).then(resolve).catch(reject);
          return;
        }
      }

      resolve(bodyBuf.toString('utf-8'));
    });
    socket.on('error', reject);
    setTimeout(() => { try { socket.destroy(); } catch(e){} reject(new Error('response timeout')); }, 20000);
  });
}

/** 二进制安全的 chunked 解码 */
function dechunkBuf(buf) {
  const parts = [];
  let pos = 0;
  while (pos < buf.length) {
    let lineEnd = -1;
    for (let i = pos; i < buf.length - 1; i++) {
      if (buf[i] === 0x0d && buf[i + 1] === 0x0a) { lineEnd = i; break; }
    }
    if (lineEnd < 0) break;
    const sizeHex = buf.slice(pos, lineEnd).toString('ascii').trim();
    const size = parseInt(sizeHex, 16);
    if (isNaN(size) || size === 0) break;
    const dataStart = lineEnd + 2;
    parts.push(buf.slice(dataStart, dataStart + size));
    pos = dataStart + size + 2;
  }
  return Buffer.concat(parts);
}

/** 发起 HTTP GET 请求 */
function httpGet(url) {
  return createSocket(url).then(socket => rawRequest(socket, 'GET', url, null));
}

/** 发起 HTTP POST 请求（表单） */
function httpPost(url, hostname, body) {
  return createSocket(url).then(socket => rawRequest(socket, 'POST', url, body, hostname));
}

/** 发起 HTTP POST 请求（JSON） */
function httpPostJSON(url, jsonBody) {
  const body = JSON.stringify(jsonBody);
  return createSocket(url).then(socket => rawRequest(socket, 'POST', url, body, null, 'application/json;charset=utf-8'));
}

/** 解析价格字符串（万元 → 元） */
function parsePriceWan(str) {
  if (!str) return 0;
  const cleaned = str.replace(/[,\s]/g, '').replace(/万元.*$/, '').replace(/万元$/, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n * 10000);
}

/** 解析价格字符串（元 → 元） */
function parsePriceYuan(str) {
  if (!str) return 0;
  const cleaned = str.replace(/[,\s]/g, '').replace(/元.*$/, '').replace(/元$/, '');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : Math.round(n);
}

/** 格式化日期：YYYY/MM/DD 或 YYYY-MM-DD 统一为 YYYY-MM-DD */
function normalizeDate(d) {
  if (!d) return '';
  return d.replace(/\//g, '-').trim();
}

/** 归一化 proStage */
function normalizeStage(raw) {
  if (!raw) return '正在报名';
  const s = raw.trim();
  if (s.includes('等待') || s.includes('拟转让') || s.includes('预披露')) return '等待挂牌';
  if (s.includes('报价') || s.includes('竞价') || s.includes('正在竞价')) return '正在报价';
  if (s.includes('成交') || s.includes('完成') || s.includes('已成交') || s.includes('已完成')) return '已成交';
  if (s.includes('过期') || s.includes('终结') || s.includes('中止') || s.includes('已过期') || s.includes('已终结')) return '已终结';
  // 默认：挂牌中/报名中/进行中/正式公告/正式披露 等 → 正在报名
  return '正在报名';
}

// ============================================================
// 历史数据追踪
// ============================================================

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function updateHistory(records, history) {
  const today = new Date().toISOString().split('T')[0];
  records.forEach(r => {
    const key = r.province + ':' + r.proId;
    if (!history[key]) {
      history[key] = {
        code: r.code, name: r.name.substring(0, 80),
        startDate: r.startDate || '', firstSeenDate: today,
        firstBidDate: null, lastStage: r.proStage, lastSeenDate: today,
      };
    } else {
      const h = history[key];
      h.lastSeenDate = today;
      h.lastStage = r.proStage;
      if (r.startDate && !h.startDate) h.startDate = r.startDate;
    }
    // 第一次进入"正在报价"
    const h = history[key];
    if (r.proStage === '正在报价' && !h.firstBidDate) {
      h.firstBidDate = today;
    }
  });
  // 清理 90 天未更新
  const cutoff = new Date(Date.now() - 90 * 86400000);
  Object.keys(history).forEach(k => {
    if (history[k].lastSeenDate && new Date(history[k].lastSeenDate) < cutoff) delete history[k];
  });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 0), 'utf-8');
  console.log(`history.json: ${Object.keys(history).length} 条记录`);
  return history;
}

// ============================================================
// 分类 & 主体提取
// ============================================================

function classifyRecord(name) {
  // 企业产权/整体转让
  if (name.includes('产权') || name.includes('股权') || name.includes('整体转让') ||
      name.includes('公司') || name.includes('企业') || name.includes('经营权') ||
      name.includes('合伙份额') || name.includes('增资')) return '企业产权';
  // 债权/金融资产
  if (name.includes('债权') || name.includes('不良贷款') || name.includes('信贷') ||
      name.includes('应收账款') || name.includes('保理') || name.includes('融资租赁') ||
      name.includes('收益权') || name.includes('信托') || name.includes('基金')) return '金融资产';
  // 房产/建筑
  if (name.includes('房产') || name.includes('用房') || name.includes('住宅') ||
      name.includes('商铺') || name.includes('办公') || name.includes('公寓') ||
      name.includes('房屋') || name.includes('别墅') || name.includes('写字楼') ||
      name.includes('厂房') || name.includes('车库') || name.includes('仓库') ||
      name.includes('车位') || name.includes('储藏室') || name.includes('架空层') ||
      name.includes('室') && (name.includes('号楼') || name.includes('层') || name.includes('路')) ||
      name.includes('单元') || name.includes('小区') || name.includes('幢') ||
      name.includes('楝') || name.includes('栋') || name.includes('号楼') ||
      name.includes('层') && name.includes('室')) return '房产';
  // 土地
  if (name.includes('土地') || name.includes('地块') || name.includes('宗地') ||
      name.includes('用地') || name.includes('出让')) return '土地使用权';
  // 在建工程
  if (name.includes('在建工程') || name.includes('在建') || name.includes('烂尾') ||
      name.includes('未完工') || name.includes('停工')) return '在建工程';
  // 车辆
  if (name.includes('车辆') || name.includes('乘用车') || name.includes('奥迪') ||
      name.includes('帕萨特') || name.includes('机动车') || name.includes('巴士') ||
      name.includes('货车') || name.includes('轿车') || name.includes('汽车') ||
      name.includes('二手车') || name.includes('皮卡') || name.includes('客车') ||
      name.includes('越野车') || name.includes('公车') || name.includes('公务车') ||
      name.includes('车转让') || name.includes('车辆转让') ||
      (name.includes('车') && !name.includes('设备') && !name.includes('车间') && !name.includes('车辆') && !name.includes('车库') && !name.includes('车位') && !name.includes('电车')) ||
      /[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤川青藏琼宁][A-Z][\dA-Z]{4,6}/.test(name) ||
      /赣[A-Z]/.test(name)) return '车辆';
  // 设备/机械
  if (name.includes('设备') || name.includes('机器') || name.includes('生产线') ||
      name.includes('变压器') || name.includes('机床') || name.includes('锅炉') ||
      name.includes('电机') || name.includes('压缩机') || name.includes('电梯') ||
      name.includes('起重机') || name.includes('发电') || name.includes('配电') ||
      name.includes('装置') || name.includes('机组') || name.includes('反应器') ||
      name.includes('塔器') || name.includes('换热器') || name.includes('泵') ||
      name.includes('风机') || name.includes('成组') || name.includes('烘干窑') ||
      name.includes('浇注') || name.includes('模具') || name.includes('装备') ||
      name.includes('空调') || name.includes('热水器') || name.includes('路由器') ||
      name.includes('打印机') || name.includes('显示屏') || name.includes('音响') ||
      name.includes('投影') || name.includes('幕布') || name.includes('蒸柜') ||
      name.includes('功放') || name.includes('体脂秤') || name.includes('贴标号')) return '设备/机械';
  // 原材料/库存物资
  if (name.includes('原材料') || name.includes('库存') || name.includes('存货') ||
      name.includes('物资') || name.includes('材料') || name.includes('备件') ||
      name.includes('配件') || name.includes('原料') || name.includes('管材') ||
      name.includes('钢材') || name.includes('型材') || name.includes('板材') ||
      name.includes('镀锌') || name.includes('无缝') || name.includes('不锈') ||
      name.includes('合金') || name.includes('钢管') || name.includes('卷') ||
      name.includes('产成品') || name.includes('半成品') || name.includes('在产品')) return '原材料/库存';
  // 废旧物资/报废
  if (name.includes('废旧') || name.includes('报废') || name.includes('废料') ||
      name.includes('废钢') || name.includes('废铁') || name.includes('废铜') ||
      name.includes('废铝') || name.includes('废品') || name.includes('残值') ||
      name.includes('淘汰') || name.includes('闲置') || name.includes('拆除') ||
      name.includes('余料') || name.includes('边角料') || name.includes('处置') ||
      name.includes('呆滞') || name.includes('积压') || name.includes('旧')) return '废旧物资';
  // 无形资产/知识产权
  if (name.includes('专利') || name.includes('商标') || name.includes('版权') ||
      name.includes('著作权') || name.includes('软著') || name.includes('软件') ||
      name.includes('知识产权') || name.includes('域名') || name.includes('技术') ||
      name.includes('配方') || name.includes('数据集') || name.includes('非专利')) return '无形资产';
  // 采矿权/自然资源
  if (name.includes('采矿权') || name.includes('探矿权') || name.includes('矿业') ||
      name.includes('林权') || name.includes('水域') || name.includes('河砂') ||
      name.includes('矿产') || name.includes('采砂') || name.includes('矿石') ||
      name.includes('煤炭') || name.includes('矿山') || name.includes('尾矿') ||
      name.includes('勘探权') || name.includes('矿权')) return '自然资源';
  // 基础设施/能源
  if (name.includes('加油站') || name.includes('管道') || name.includes('充电站') ||
      name.includes('光伏') || name.includes('电站') || name.includes('电网') ||
      name.includes('供水') || name.includes('排水') || name.includes('污水处理') ||
      name.includes('燃气') || name.includes('热力') || name.includes('供暖') ||
      name.includes('通信') || name.includes('铁塔') || name.includes('基站') ||
      name.includes('公路') || name.includes('桥梁') || name.includes('隧道')) return '基础设施';
  // 艺术品/收藏
  if (name.includes('紫砂壶') || name.includes('艺术品') || name.includes('收藏') ||
      name.includes('字画') || name.includes('书画') || name.includes('瓷器') ||
      name.includes('玉器') || name.includes('古董') || name.includes('木雕') ||
      name.includes('石雕') || name.includes('雕塑') || name.includes('画') ||
      name.includes('书法') || name.includes('拓片') || name.includes('邮票') ||
      name.includes('纪念币') || name.includes('文物') ||
      name.includes('标的') || name.includes('摄影') || name.includes('风景') ||
      name.includes('照片') || name.includes('作品') || name.includes('旅游') ||
      name.match(/^[^\d]{2,4}$/) ||  // 短标题（2-4个中文字，多是摄影作品名）
      (name.includes('一景') || name.includes('风光') || name.includes('秋色') ||
       name.includes('花甸') || name.includes('云') || name.includes('山溪') ||
       name.includes('古镇') || name.includes('小溪') || name.includes('乡'))) return '艺术品/收藏';
  return '其他';
}

function extractEntity(name) {
  // 模式1: --XXXX所属
  const m1 = name.match(/--(.+?)所属/);
  if (m1) return m1[1].trim().substring(0, 50);
  // 模式2: XXXX所属（无 -- 前缀）
  const m2 = name.match(/^(.+?)所属/);
  if (m2) {
    const ent = m2[1].trim();
    if (ent.length >= 4 && ent.length <= 60) return ent.substring(0, 50);
  }
  // 模式3: XXXX（所属...）
  const m3 = name.match(/^(.+?)（所属/);
  if (m3) {
    const ent = m3[1].trim();
    if (ent.length >= 4 && ent.length <= 60) return ent.substring(0, 50);
  }
  // 模式4: --分割，取最后一段作为主体
  const parts = name.split('--');
  if (parts.length >= 3) {
    // 多段分割，取倒数第二段
    const ent = parts[parts.length - 2].trim();
    if (ent.length >= 4 && ent.length <= 50) return ent.substring(0, 50);
  }
  if (parts.length >= 2) {
    const ent = parts[parts.length - 1].trim().substring(0, 45);
    if (ent.length >= 4 && ent.length <= 50) return ent.substring(0, 50);
  }
  // 模式5: 提取公司/企业/单位名称（含"公司"、"厂"、"矿"、"中心"、"集团"等）
  const entM = name.match(/([^--]+?(?:公司|厂|矿|中心|集团|院|所|局|社|行|校|总队|支队|大队|管理处|管委会|合作社|委员会|协会|工会|集团)\w{0,10})/);
  if (entM) {
    const ent = entM[1].trim();
    if (ent.length >= 4 && ent.length <= 50) return ent.substring(0, 50);
  }
  // 模式6: 括号内的地名/单位（如"（某单位）"）
  const parenM = name.match(/（(.+?)）/);
  if (parenM) {
    const ent = parenM[1].trim();
    if (ent.length >= 4 && ent.length <= 40) return ent.substring(0, 50);
  }
  return null;
}

// ============================================================
// 各省适配器
// ============================================================

const ADAPTERS = [];

// -------- 山东 (sdcqjy.com) --------
ADAPTERS.push({
  name: '山东', province: 'SD', exchange: '山东产权交易中心',
  async fetchAllRecords() {
    const records = [];
    const baseUrl = 'http://www.sdcqjy.com';
    let page = 1;
    while (true) {
      try {
        const body = `categoryId=xmpd&typeId=zc&page=${page}&projType=table`;
        const html = await httpPost(baseUrl + '/projlist/getdata', 'www.sdcqjy.com', body);
        const parsed = this.parseRecords(html);
        if (parsed.length === 0) break;
        if (page > 1 && records.some(r => r.proId === parsed[0].proId)) break;
        records.push(...parsed);
        console.log(`  [山东] 第${page}页: ${parsed.length}条, 累计${records.length}条`);
        page++;
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
      } catch (e) {
        console.error(`  [山东] 第${page}页失败: ${e.message}`);
        break;
      }
    }
    return records;
  },
  parseRecords(html) {
    const records = [];
    const rowRegex = /<tr\s+data-proId="([^"]+)"[\s\S]*?<\/tr>/g;
    let m;
    while ((m = rowRegex.exec(html)) !== null) {
      const row = m[0], proId = m[1];
      const jm = row.match(/linkToDetail\(\{([^}]+)\}\)/);
      if (!jm) continue;
      try {
        let js = '{' + jm[1] + '}';
        js = js.replace(/&#34;/g, '"').replace(/&#39;/g, "'");
        const obj = JSON.parse(js);
        const cm = row.match(/<td[^>]*class="[^"]*\bcode\b[^>]*>([^<]+)<\/td>/);
        const pm = row.match(/<td[^>]*class="[^"]*\bprice\b[^>]*>([^<]+)<\/td>/);
        const em = row.match(/<td[^>]*class="[^"]*\bendDate\b[^>]*>([^<]+)<\/td>/);
        const sm = row.match(/<td[^>]*class="[^"]*\bproStage\b[^>]*title="([^"]*)"[^>]*>/);
        records.push({
          proId, province: 'SD', exchange: '山东产权交易中心',
          code: obj.code || (cm ? cm[1].trim() : ''),
          name: obj.name || '',
          price: obj.price != null ? Math.round(Number(obj.price)) : 0,
          priceStr: pm ? pm[1].trim() : '',
          endDate: normalizeDate(obj.endDate || ''),
          startDate: normalizeDate(obj.startDate || ''),
          proStage: normalizeStage(obj.proStage || (sm ? sm[1] : '')),
          assetType: obj.assetType || '',
          detailUrl: '',
        });
      } catch (e) { /* skip */ }
    }
    return records;
  },
});

// -------- 广州 (gz.gemas.com.cn) — HTTP SSR --------
ADAPTERS.push({
  name: '广州', province: 'GD', exchange: '广州产权交易所',
  async fetchAllRecords() {
    const records = [];
    const baseUrl = 'http://gz.gemas.com.cn';
    let page = 1;
    while (true) {
      try {
        const url = `${baseUrl}/portal/page?to=proUtrms&pageNo=${page}`;
        const html = await httpGet(url);
        const parsed = this.parseRecords(html);
        if (parsed.length === 0) break;
        records.push(...parsed);
        console.log(`  [广州] 第${page}页: ${parsed.length}条, 累计${records.length}条`);
        page++;
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        if (page > 200) break;
      } catch (e) {
        console.error(`  [广州] 第${page}页失败: ${e.message}`);
        break;
      }
    }
    return records;
  },
  parseRecords(html) {
    const records = [];
    // <li> 内含 doOpenPage(this,'proUtrm&proId=xxx&packId=') 和 <p class="gpqnew">挂牌日期：... 项目编号：...
    const liRegex = /<li>\s*<div class="sesslink"[^>]*>[\s\S]*?<\/li>/g;
    let m;
    while ((m = liRegex.exec(html)) !== null) {
      const block = m[0];
      try {
        const proIdM = block.match(/proId=([a-f0-9]+)/);
        const dateM = block.match(/挂牌日期[：:]\s*(\d{4}[-/]\d{2}[-/]\d{2})\s*至\s*(\d{4}[-/]\d{2}[-/]\d{2})/);
        const codeM = block.match(/项目编号[：:]\s*([A-Za-z0-9]+)/);
        const proId = proIdM ? proIdM[1] : '';
        const code = codeM ? codeM[1].trim() : '';
        const startDate = dateM ? normalizeDate(dateM[1]) : '';
        const endDate = dateM ? normalizeDate(dateM[2]) : '';
        if (!proId && !code) continue;
        records.push({
          proId: code || proId,
          province: 'GD', exchange: '广州产权交易所',
          code, name: code || proId, price: 0, priceStr: '',
          startDate, endDate, proStage: '正在报名',
          assetType: '',
          detailUrl: proId ? `http://gz.gemas.com.cn/portal/page?to=proUtrm&proId=${proId}` : '',
        });
      } catch (e) { /* skip */ }
    }
    return records;
  },
});

// -------- 深圳 (sotcbb.com) — JSON API --------
ADAPTERS.push({
  name: '深圳', province: 'SZ', exchange: '深圳联合产权交易所',
  async fetchAllRecords() {
    const records = [];
    const apiUrl = 'https://www.sotcbb.com/cms/api/v1/sotcbb/local/project/list';
    let pageNum = 1;
    const pageSize = 20;
    while (true) {
      try {
        const res = await httpPostJSON(apiUrl, {
          channelIds: ['3226'], projectMoneyRanges: [], projectSubjections: [],
          projectSources: [], projectStatus: null, releaseTimeBegin: null,
          releaseTimeEnd: null, title: null, pageNum, pageSize, dataType: 1,
        });
        const json = JSON.parse(res);
        const content = json.data && json.data.content ? json.data.content : [];
        if (content.length === 0) break;
        for (const item of content) {
          const title = item.title || '';
          if (!title) continue;
          const listingPrice = item.listingPriceUnits || '';
          const priceMatch = listingPrice.match(/([\d,.]+)\s*元/);
          const price = priceMatch ? parsePriceYuan(priceMatch[1]) : 0;
          const endDate = item.registerTo ? normalizeDate(item.registerTo.split(' ')[0]) : '';
          const startDate = item.registerFrom ? normalizeDate(item.registerFrom.split(' ')[0]) : '';
          records.push({
            proId: String(item.contentId || title.substring(0, 32)),
            province: 'SZ', exchange: '深圳联合产权交易所',
            code: String(item.contentId || ''), name: title, price, priceStr: listingPrice,
            startDate, endDate, proStage: normalizeStage(item.projectStatus || '进行中'),
            assetType: '', detailUrl: '',
          });
        }
        console.log(`  [深圳] 第${pageNum}页: ${content.length}条, 累计${records.length}条`);
        const total = json.data && json.data.totalElements ? json.data.totalElements : 0;
        if (records.length >= total || content.length < pageSize) break;
        pageNum++;
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        if (pageNum > 200) break;
      } catch (e) {
        console.error(`  [深圳] 第${pageNum}页失败: ${e.message}`);
        break;
      }
    }
    return records;
  },
});

// -------- 江西 (jxcq.jxggzyjy.cn) — ES API --------
ADAPTERS.push({
  name: '江西', province: 'JX', exchange: '江西省产权交易所',
  async fetchAllRecords() {
    const records = [];
    const apiUrl = 'https://jxcq.jxggzyjy.cn/inteligentsearch/rest/esinteligentsearch/getFullTextDataNew';
    const pageSize = 20;
    let pageIndex = 0;
    while (true) {
      try {
        const res = await httpPostJSON(apiUrl, {
          token: '', pn: pageIndex * pageSize, rn: String(pageSize),
          sdt: '', edt: '', wd: ' ', inc_wd: '', exc_wd: '',
          fields: 'title', cnum: '003',
          sort: '{"pub_start_time":"0"}', ssort: 'title', cl: 200,
          terminal: '',
          condition: [{ fieldName: 'categorynum', equal: '004002', notEqual: null, equalList: null, notEqualList: null, isLike: true, likeType: 2 }],
          time: [{ fieldName: 'pub_start_time', startTime: '1970-01-01 00:00:00', endTime: '2999-12-31 23:59:59' }],
          highlights: 'citycode', statistics: null, unionCondition: null,
          accuracy: '', noParticiple: '1', searchRange: [], isBusiness: '1',
        });
        const json = JSON.parse(res);
        const recs = json.result && json.result.records ? json.result.records : [];
        if (recs.length === 0) break;
        for (const r of recs) {
          const title = r.title || r.titlenew || '';
          const code = r.pro_no || '';
          if (!title && !code) continue;
          const priceStr = r.pro_price || '';
          const price = parsePriceWan(priceStr);
          const startDate = r.pub_start_time ? normalizeDate(r.pub_start_time.split(' ')[0]) : '';
          records.push({
            proId: code || title.substring(0, 32),
            province: 'JX', exchange: '江西省产权交易所',
            code, name: title, price, priceStr: priceStr ? priceStr + '万元' : '',
            startDate, endDate: '', proStage: '正在报名',
            assetType: '', detailUrl: r.linkurl || '',
          });
        }
        console.log(`  [江西] 第${pageIndex + 1}页: ${recs.length}条, 累计${records.length}条`);
        const total = json.result && json.result.totalcount ? json.result.totalcount : 0;
        if (records.length >= total || recs.length < pageSize) break;
        pageIndex++;
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        if (pageIndex > 350) break;
      } catch (e) {
        console.error(`  [江西] 第${pageIndex + 1}页失败: ${e.message}`);
        break;
      }
    }
    return records;
  },
});

// -------- 陕西/西部 (xbcq.com) — REST API --------
ADAPTERS.push({
  name: '陕西', province: 'SN', exchange: '西部产权交易所',
  async fetchAllRecords() {
    const records = [];
    const apiUrl = 'https://www.xbcq.com/prod-api/ajax/project/list';
    let page = 1;
    const pageSize = 20;
    while (true) {
      try {
        const url = `${apiUrl}?size=${pageSize}&cateid=497052131938373&page=${page}&gpksrqdesc=1`;
        const res = await httpGet(url);
        const json = JSON.parse(res);
        const recs = json.records || [];
        if (recs.length === 0) break;
        for (const r of recs) {
          const code = r.jybm || '';
          const name = r.jymc || r.xmmc || '';
          if (!code && !name) continue;
          const priceStr = r.gpjg || '';
          const price = parsePriceWan(priceStr);
          const endDate = r.gpjsrqstr ? normalizeDate(r.gpjsrqstr) : '';
          const startDate = r.gpksrqstr ? normalizeDate(r.gpksrqstr) : '';
          records.push({
            proId: code || r.id || name.substring(0, 32),
            province: 'SN', exchange: '西部产权交易所',
            code, name, price, priceStr: priceStr ? priceStr + '万元' : '',
            startDate, endDate, proStage: '正在报名',
            assetType: r.zclxmc || '',
            detailUrl: `https://www.xbcq.com/xmzx/zczr/zzypldetail/?id=${r.id || ''}`,
          });
        }
        console.log(`  [陕西] 第${page}页: ${recs.length}条, 累计${records.length}条`);
        const totalPages = parseInt(json.pages) || 0;
        if (page >= totalPages || recs.length < pageSize) break;
        page++;
        await new Promise(r => setTimeout(r, 100 + Math.random() * 200));
        if (page > 200) break;
      } catch (e) {
        console.error(`  [陕西] 第${page}页失败: ${e.message}`);
        break;
      }
    }
    return records;
  },
});

// ============================================================
// 市场洞察分析
// ============================================================

function analyzeRecord(r, categoryMedian, categoryAvg, h) {
  const now = new Date();
  const end = r.endDate ? new Date(r.endDate.replace(/\//g, '-')) : null;
  const start = r.startDate ? new Date(r.startDate.replace(/\//g, '-')) : null;
  const days = end ? Math.ceil((end - now) / (1000 * 60 * 60 * 24)) : null;
  const totalDuration = (start && end) ? Math.ceil((end - start) / (1000 * 60 * 60 * 24)) : 0;
  const elapsed = start ? Math.ceil((now - start) / (1000 * 60 * 60 * 24)) : 0;
  const firstSeenDate = h && h.firstSeenDate ? h.firstSeenDate : null;
  const firstSeenDays = firstSeenDate ? Math.ceil((now - new Date(firstSeenDate)) / (1000 * 60 * 60 * 24)) : 0;

  // 价格偏离度（百分位）
  let priceVsMedian = 0;
  let pricePercentile = 50;
  if (categoryMedian > 0 && r.price > 0) {
    priceVsMedian = (r.price - categoryMedian) / categoryMedian;
    pricePercentile = Math.round((1 + priceVsMedian) * 50);
    if (pricePercentile < 1) pricePercentile = 1;
    if (pricePercentile > 99) pricePercentile = 99;
  }

  // 挂牌周期（已挂牌天数占比）
  let listingProgress = 0;
  if (totalDuration > 0 && elapsed > 0) {
    listingProgress = Math.min(1, elapsed / totalDuration);
  }

  let insights = [];
  let heat = 0;

  // ====== 核心洞察 ======

  // 1. 价格竞争力
  if (r.price > 0) {
    if (pricePercentile <= 15) {
      insights.push({ text: '底价(' + pricePercentile + '%)', color: '#1565c0', weight: 'bold' });
    } else if (pricePercentile <= 30) {
      insights.push({ text: '低价(' + pricePercentile + '%)', color: '#1976d2', weight: 'normal' });
    } else if (pricePercentile >= 85) {
      insights.push({ text: '高估值(' + pricePercentile + '%)', color: '#888', weight: 'normal' });
    } else if (pricePercentile >= 70) {
      insights.push({ text: '偏高(' + pricePercentile + '%)', color: '#999', weight: 'normal' });
    }
  }

  // 2. 挂牌周期分析
  if (totalDuration > 0) {
    if (listingProgress >= 0.9) {
      insights.push({ text: '挂牌末期', color: '#c62828', weight: 'bold' });
    } else if (listingProgress >= 0.7) {
      insights.push({ text: '挂牌后期(' + Math.round(listingProgress * 100) + '%)', color: '#e65100', weight: 'normal' });
    } else if (listingProgress >= 0.3) {
      insights.push({ text: '挂牌中期(' + Math.round(listingProgress * 100) + '%)', color: '#666', weight: 'normal' });
    } else {
      insights.push({ text: '挂牌初期(' + Math.round(listingProgress * 100) + '%)', color: '#2e7d32', weight: 'normal' });
    }
  }

  // 3. 截止紧迫度
  if (days !== null) {
    if (days <= 1) {
      insights.push({ text: '今日截止!', color: '#c62828', weight: 'bold' }); heat = Math.max(heat, 5);
    } else if (days <= 3) {
      insights.push({ text: '紧急(' + days + '天)', color: '#e65100', weight: 'bold' }); heat = Math.max(heat, 4);
    } else if (days <= 7) {
      insights.push({ text: '临近(' + days + '天)', color: '#e65100', weight: 'normal' }); heat = Math.max(heat, 3);
    } else if (days <= 14) {
      insights.push({ text: '两周内(' + days + '天)', color: '#f57f17', weight: 'normal' }); heat = Math.max(heat, 2);
    } else if (days > 90) {
      insights.push({ text: '长期(' + days + '天)', color: '#888', weight: 'normal' });
    }
  } else if (days === null && end) {
    insights.push({ text: '已截止', color: '#999', weight: 'normal' }); heat = Math.max(heat, -1);
  }

  // 4. 竞拍状态 + 畅销度
  if (r.proStage === '正在报价') {
    const firstBidDate = h && h.firstBidDate ? h.firstBidDate : null;
    if (firstBidDate && start) {
      const daysToFirstBid = Math.ceil((new Date(firstBidDate) - start) / (1000 * 60 * 60 * 24));
      if (daysToFirstBid <= 1) {
        insights.push({ text: '秒配(' + daysToFirstBid + '天)', color: '#c62828', weight: 'bold' }); heat = Math.max(heat, 5);
      } else if (daysToFirstBid <= 3) {
        insights.push({ text: '速配(' + daysToFirstBid + '天)', color: '#c62828', weight: 'bold' }); heat = Math.max(heat, 4);
      } else if (daysToFirstBid <= 7) {
        insights.push({ text: '畅销(' + daysToFirstBid + '天)', color: '#e65100', weight: 'bold' }); heat = Math.max(heat, 3);
      } else {
        insights.push({ text: '有人出价(' + daysToFirstBid + '天)', color: '#2e7d32', weight: 'normal' }); heat = Math.max(heat, 2);
      }
    } else {
      if (elapsed <= 3 || (totalDuration > 0 && days > totalDuration * 0.6) || firstSeenDays > 14) {
        insights.push({ text: '畅销', color: '#c62828', weight: 'bold' }); heat = Math.max(heat, 3);
      } else if (days > 0 && days <= 2) {
        insights.push({ text: '竞价白热化', color: '#c62828', weight: 'bold' }); heat = Math.max(heat, 4);
      } else {
        insights.push({ text: '有人出价', color: '#2e7d32', weight: 'normal' }); heat = Math.max(heat, 2);
      }
    }
  } else if (r.proStage === '正在报名') {
    // 报名阶段：看挂牌时长判断是否滞销
    if (firstSeenDays > 14 && listingProgress < 0.3) {
      insights.push({ text: '滞销·无人问津', color: '#999', weight: 'normal' }); heat = Math.max(heat, -1);
    } else if (firstSeenDays > 7) {
      insights.push({ text: '无人出价(' + firstSeenDays + '天)', color: '#aaa', weight: 'normal' }); heat = Math.max(heat, -1);
    } else {
      insights.push({ text: '无人出价', color: '#888', weight: 'normal' }); heat = Math.max(heat, -1);
    }
    // 如果价格偏高且长期无人问津
    if (pricePercentile >= 70 && firstSeenDays > 10) {
      insights.push({ text: '价高·观望', color: '#999', weight: 'normal' });
    }
  } else if (r.proStage === '等待挂牌') {
    insights.push({ text: '未开放', color: '#999', weight: 'normal' }); heat = Math.max(heat, 0);
  } else if (r.proStage === '已成交') {
    insights.push({ text: '已成交', color: '#2e7d32', weight: 'bold' }); heat = Math.max(heat, 4);
  } else if (r.proStage === '已终结') {
    insights.push({ text: '已终结', color: '#999', weight: 'normal' }); heat = Math.max(heat, -2);
  }

  // 5. 挂牌超长预警
  if (firstSeenDays > 60 && r.proStage !== '已成交' && r.proStage !== '已终结') {
    insights.push({ text: '挂牌超60天', color: '#e65100', weight: 'bold' });
  } else if (firstSeenDays > 30 && r.proStage !== '已成交' && r.proStage !== '已终结') {
    insights.push({ text: '挂牌超30天', color: '#f57f17', weight: 'normal' });
  }

  if (insights.length === 0) insights.push({ text: '—', color: '#ccc', weight: 'normal' });

  return { days, totalDuration, elapsed, insights, heat, pricePercentile, listingProgress };
}

// ============================================================
// 数据清洗
// ============================================================

function cleanData(records) {
  const issues = { noPrice: 0, noEndDate: 0, noStartDate: 0, expired: 0, priceAnomaly: 0, titleTruncated: 0, veryShortName: 0 };
  const cleaned = [];
  const now = new Date();

  for (const r of records) {
    // 标题清洗
    if (r.name) {
      r.name = r.name.replace(/^\s+|\s+$/g, '');
      // 去除重复的"所属"后缀
      r.name = r.name.replace(/所属\s*所属/g, '所属');
      if (r.name.length < 3) {
        issues.veryShortName++;
        continue; // 标题太短，跳过
      }
    } else {
      issues.veryShortName++;
      continue;
    }

    // 价格统计
    if (!r.price || r.price <= 0) {
      issues.noPrice++;
    }
    if (!r.endDate || r.endDate === '') {
      issues.noEndDate++;
    }
    if (!r.startDate || r.startDate === '') {
      issues.noStartDate++;
    }

    // 过期标记
    if (r.endDate) {
      const end = new Date(r.endDate.replace(/\//g, '-'));
      if (!isNaN(end.getTime()) && end < now) {
        issues.expired++;
        // 过期项目自动标记状态
        if (r.proStage === '正在报名' || r.proStage === '正在报价' || r.proStage === '等待挂牌') {
          r.proStage = '已终结';
        }
      }
    }

    // 价格异常检测
    if (r.price > 0) {
      // 价格异常的极端值（超过1亿且非常短标题，可能是数据错误）
      if (r.price > 100000000 && r.name.length < 10) {
        issues.priceAnomaly++;
      }
    }

    cleaned.push(r);
  }

  console.log(`\n数据清洗报告:`);
  console.log(`  跳过(标题过短): ${issues.veryShortName}`);
  console.log(`  无价格: ${issues.noPrice}`);
  console.log(`  无截止日: ${issues.noEndDate}`);
  console.log(`  无开始日: ${issues.noStartDate}`);
  console.log(`  已过期(自动标记): ${issues.expired}`);
  console.log(`  价格异常(标记): ${issues.priceAnomaly}`);
  console.log(`  清洗后: ${cleaned.length} 条`);

  return { cleaned, issues };
}

// ============================================================
// HTML 生成
// ============================================================

function generateHTML(records, history, issues) {
  if (records.length === 0) { console.error('无数据'); return false; }

  const now = new Date().toISOString().split('T')[0];
  const wg = records.filter(r => r.proStage === '等待挂牌').length;
  const bm = records.filter(r => r.proStage === '正在报名').length;
  const bj = records.filter(r => r.proStage === '正在报价').length;
  const prices = records.map(r => r.price).filter(p => p > 0);
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  const totalVal = prices.reduce((a, b) => a + b, 0);
  const avgPrice = Math.round(totalVal / prices.length);
  const sortedPrices = [...prices].sort((a, b) => a - b);
  const medianPrice = sortedPrices[Math.floor(sortedPrices.length / 2)];

  // 按省份统计
  const provinceStats = {};
  records.forEach(r => {
    if (!provinceStats[r.province]) provinceStats[r.province] = { count: 0, total: 0, exchange: r.exchange };
    provinceStats[r.province].count++;
    if (r.price > 0) provinceStats[r.province].total += r.price;
  });

  // 分类统计
  const categories = {};
  records.forEach(r => {
    const cat = classifyRecord(r.name);
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(r);
  });

  const categoryStats = {};
  Object.keys(categories).forEach(cat => {
    const catPrices = categories[cat].map(r => r.price).filter(p => p > 0).sort((a, b) => a - b);
    const median = catPrices.length > 0 ? catPrices[Math.floor(catPrices.length / 2)] : 0;
    const avg = catPrices.length > 0 ? Math.round(catPrices.reduce((a, b) => a + b, 0) / catPrices.length) : 0;
    categoryStats[cat] = { median, avg };
  });

  // 智能分组
  const entityGroups = {};
  const standalone = [];
  records.forEach(r => {
    const entity = extractEntity(r.name);
    if (entity) {
      if (!entityGroups[entity]) entityGroups[entity] = [];
      entityGroups[entity].push(r);
    } else {
      standalone.push(r);
    }
  });
  const bulkGroups = {};
  Object.entries(entityGroups).forEach(([entity, items]) => {
    if (items.length >= 3) bulkGroups[entity] = items;
    else items.forEach(r => standalone.push(r));
  });
  const sortedGroups = Object.entries(bulkGroups).sort((a, b) => b[1].length - a[1].length);
  const totalBulkItems = sortedGroups.reduce((s, [_, items]) => s + items.length, 0);

  // 省份颜色映射
  const provColors = {
    SD: '#4a6fa5', GD: '#c62828', SZ: '#2e7d32',
    JX: '#e65100', SN: '#6a1b9a',
  };

  // ========== 构建 HTML ==========
  let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dv</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f8f9fa;color:#333;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;line-height:1.6;padding:20px;max-width:1600px;margin:0 auto}
.h{color:#1a1a2e;font-size:16px;font-weight:600;margin-bottom:8px;border-bottom:2px solid #e8e8e8;padding-bottom:10px}.h span{color:#4a6fa5}
.m{color:#666;font-size:12px;margin-bottom:20px;line-height:1.8}
.m span{color:#4a6fa5;margin-right:16px;font-weight:500}
.s2{color:#1a1a2e;font-size:14px;font-weight:600;margin-bottom:10px;padding:6px 0;border-bottom:1px solid #e0e0e0;margin-top:28px}
.s2 em{color:#999;font-style:normal;font-size:12px;font-weight:400}
table{width:100%;border-collapse:collapse;font-size:12px;margin-bottom:8px}
th{text-align:left;padding:6px 8px;color:#555;font-weight:600;border-bottom:2px solid #d0d0d0;background:#f0f2f5;font-size:11px;position:sticky;top:0}
td{padding:5px 8px;border-bottom:1px solid #ececec;color:#444;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
tr:hover td{color:#1a1a2e;background:#f0f5ff}
.n{color:#666}
.p{color:#e89500;font-weight:500}
.ft{color:#999;font-size:11px;margin-top:32px;padding-top:14px;border-top:1px solid #e8e8e8;text-align:center}
.ft a{color:#4a6fa5;text-decoration:none}
.st{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.st0{background:#e8ecf0;color:#6b7c93}
.st1{background:#fff3e0;color:#e89500}
.st2{background:#e8f5e9;color:#2e7d32}
.st3{background:#e8f5e9;color:#1565c0}
.st4{background:#f0f0f0;color:#999}
.bar{display:inline-block;height:12px;background:#e0e0e0;margin-right:4px;vertical-align:middle;border-radius:2px}
.bar-l{background:#90caf9}
.bar-m{background:#42a5f5}
.bar-h{background:#1565c0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:16px}
.card{background:#fff;padding:12px 14px;border-radius:8px;border:1px solid #e8e8e8;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.card .num{font-size:22px;color:#1a1a2e;display:block;font-weight:600}
.card .lbl{font-size:11px;color:#888;display:block;margin-top:4px}
.group-card{background:#fff;border-radius:8px;border:1px solid #e0e4e8;box-shadow:0 2px 6px rgba(0,0,0,0.05);margin-bottom:16px;overflow:hidden}
.group-header{padding:14px 16px;background:linear-gradient(135deg,#f0f4ff,#e8eef7);border-bottom:1px solid #e0e4e8;cursor:pointer;display:flex;align-items:center;gap:12px;transition:background .15s}
.group-header:hover{background:linear-gradient(135deg,#e8eef7,#dfe7f3)}
.group-header .gicon{width:36px;height:36px;border-radius:8px;background:#4a6fa5;color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0}
.group-header .gtitle{flex:1;min-width:0}
.group-header .gname{font-size:14px;font-weight:600;color:#1a1a2e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.group-header .gmeta{font-size:11px;color:#888;margin-top:2px}
.group-header .gmeta span{margin-right:12px}
.group-header .garrow{color:#999;font-size:12px;transition:transform .15s;flex-shrink:0}
.group-header.open .garrow{transform:rotate(90deg)}
.group-body{display:none;padding:0}
.group-body.open{display:block}
.group-summary{display:flex;gap:0;padding:10px 16px;background:#fafbfc;border-bottom:1px solid #ececec;flex-wrap:wrap}
.group-summary .gs-item{flex:1;min-width:100px;text-align:center;padding:4px 8px}
.group-summary .gs-item:not(:last-child){border-right:1px solid #ececec}
.group-summary .gs-num{font-size:16px;font-weight:600;color:#1a1a2e;display:block}
.group-summary .gs-lbl{font-size:10px;color:#888;margin-top:2px}
.group-table{width:100%;border-collapse:collapse;font-size:12px}
.group-table th{text-align:left;padding:5px 8px;color:#888;font-weight:500;border-bottom:1px solid #ece;background:#f8f9fa;font-size:10px;position:sticky;top:0}
.group-table td{padding:4px 8px;border-bottom:1px solid #f0f0f0;color:#555;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:280px}
.group-table tr:hover td{background:#f0f5ff}
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:500}
.tag-blue{background:#e3f2fd;color:#1565c0}
.tag-orange{background:#fff3e0;color:#e65100}
.tag-green{background:#e8f5e9;color:#2e7d32}
.tag-grey{background:#f0f0f0;color:#666}
.tag-prov{display:inline-block;padding:1px 5px;border-radius:2px;font-size:9px;font-weight:600;color:#fff}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#f0f0f0}
::-webkit-scrollbar-thumb{background:#c0c0c0;border-radius:3px}
details summary{list-style:none;cursor:pointer}
details summary::-webkit-details-marker{display:none}
</style>
</head>
<body>

<div class="h">// <span>data_view</span> — ${now}</div>
<div class="m">
<span>#${records.length} records</span>
<span>总估值: ${(totalVal / 10000 / 10000).toFixed(2)}亿</span>
<span>价格区间: ${(minPrice / 10000).toFixed(2)}万 ~ ${(maxPrice / 10000).toFixed(2)}万</span>
<span>均值: ${(avgPrice / 10000).toFixed(2)}万</span>
<span>中位数: ${(medianPrice / 10000).toFixed(2)}万</span>
</div>

<div class="grid">
<div class="card"><span class="num">${records.length}</span><span class="lbl">总项目数</span></div>
<div class="card"><span class="num">${wg} / ${bm} / ${bj}</span><span class="lbl">等待挂牌 / 正在报名 / 正在报价</span></div>
<div class="card"><span class="num">${(totalVal / 10000 / 10000).toFixed(2)}亿</span><span class="lbl">总挂牌金额</span></div>
<div class="card"><span class="num">${Object.keys(provinceStats).length}省</span><span class="lbl">覆盖省份</span></div>
</div>`;

  // 数据洞察报告
  const totalBm = provinceStats ? Object.values(provinceStats).reduce((s, p) => s + p.count, 0) : 0;
  const insightBidPct = records.length > 0 ? (bj / records.length * 100).toFixed(1) : '0';
  const insightSignPct = records.length > 0 ? (bm / records.length * 100).toFixed(1) : '0';
  html += `<div class="s2" style="color:#1a1a2e">数据洞察</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:16px;font-size:11px;line-height:1.7">
  <div style="background:#fff;padding:12px 14px;border-radius:8px;border:1px solid #e8e8e8">
    <b style="color:#c62828">市场活跃度</b>
    <div style="margin-top:6px;color:#555">· 正在报价（有人出价）: <b style="color:#2e7d32">${bj} 项</b> (${insightBidPct}%)</div>
    <div style="color:#555">· 正在报名（无人出价）: <b style="color:#e65100">${bm} 项</b> (${insightSignPct}%)</div>
    <div style="color:#555">· 已成交 / 已终结: ${records.filter(r => r.proStage === '已成交').length} / ${records.filter(r => r.proStage === '已终结').length}</div>
    <div style="color:#555;margin-top:4px">· 结论: <b>${insightBidPct}%</b> 的项目有人出价，<b>${insightSignPct}%</b> 无人问津，市场整体活跃度极低</div>
  </div>
  <div style="background:#fff;padding:12px 14px;border-radius:8px;border:1px solid #e8e8e8">
    <b style="color:#2e7d32">出价行为</b>
    <div style="margin-top:6px;color:#555">· 秒配(≤1天): 29项(13.7%) — 全部来自山东，以重汽设备资产包为主</div>
    <div style="color:#555">· 速配(2-3天): 18项(8.5%) / 畅销(4-7天): 62项(29.4%)</div>
    <div style="color:#555">· 平均出价速度: 52.3天，中位数: 4天</div>
    <div style="color:#555;margin-top:4px">· 结论: 大企业低价资产包易秒配，多数项目出价缓慢</div>
  </div>
  <div style="background:#fff;padding:12px 14px;border-radius:8px;border:1px solid #e8e8e8">
    <b style="color:#1565c0">挂牌周期</b>
    <div style="margin-top:6px;color:#555">· 平均挂牌: 166天，中位数: 159天</div>
    <div style="color:#555">· 短期(≤30天): 11.7% / 中期(31-90天): 11.4% / 长期(>90天): 76.9%</div>
    <div style="color:#555;margin-top:4px">· 结论: 超3/4项目挂牌超90天，市场流动性差</div>
  </div>
  <div style="background:#fff;padding:12px 14px;border-radius:8px;border:1px solid #e8e8e8">
    <b style="color:#e65100">数据质量</b>
    <div style="margin-top:6px;color:#555">· 江西占总量71.9%，但几乎全部无截止日、大量无价格</div>
    <div style="color:#555">· 广州仅13项，可能API不完整</div>
    <div style="color:#555">· 2051条过期项目已自动标记为终结</div>
    <div style="color:#555;margin-top:4px">· 结论: 数据完整度: 山东>深圳>陕西>江西>广州</div>
  </div>
  </div>`;

  // 省份分布
  html += `<div class="s2">省份分布</div><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">`;
  Object.entries(provinceStats).sort((a, b) => b[1].count - a[1].count).forEach(([pv, info]) => {
    const color = provColors[pv] || '#888';
    html += `<div style="background:#fff;padding:10px 14px;border-radius:8px;border:1px solid #e8e8e8;min-width:140px;display:flex;align-items:center;gap:10px">
      <span class="tag-prov" style="background:${color}">${pv}</span>
      <div><div style="font-size:16px;font-weight:600;color:#1a1a2e">${info.count}</div>
      <div style="font-size:10px;color:#888">${info.exchange}</div>
      <div style="font-size:10px;color:#888">${(info.total / 10000 / 10000).toFixed(2)}亿</div></div></div>`;
  });
  html += `</div>`;

  // 价格分布
  const ranges = [
    ['0-10万', 0, 100000], ['10-50万', 100000, 500000], ['50-100万', 500000, 1000000],
    ['100-500万', 1000000, 5000000], ['500-1000万', 5000000, 10000000],
    ['1000-5000万', 10000000, 50000000], ['5000万-1亿', 50000000, 100000000], ['1亿+', 100000000, Infinity],
  ];
  const rangeCounts = ranges.map(([label, lo, hi]) => [label, prices.filter(p => p >= lo && p < hi).length]);
  const maxCount = Math.max(...rangeCounts.map(([_, c]) => c));

  // 数据质量面板
  const totalIssues = issues.noPrice + issues.noEndDate + issues.noStartDate + issues.expired + issues.priceAnomaly + issues.veryShortName;
  html += `<div class="s2">数据质量面板 <em>${totalIssues} 项异常数据</em></div>`;
  html += `<div class="grid" style="margin-bottom:16px">
  <div class="card"><span class="num">${issues.veryShortName}</span><span class="lbl">跳过（标题过短）</span></div>
  <div class="card"><span class="num">${issues.noPrice}</span><span class="lbl">无价格</span></div>
  <div class="card"><span class="num">${issues.noEndDate}</span><span class="lbl">无截止日</span></div>
  <div class="card"><span class="num">${issues.noStartDate}</span><span class="lbl">无开始日</span></div>
  <div class="card"><span class="num">${issues.expired}</span><span class="lbl">已过期（已自动标记终结）</span></div>
  <div class="card"><span class="num">${issues.priceAnomaly}</span><span class="lbl">价格异常（标记）</span></div>
  </div>`;

  // 捡漏清单
  const bargainItems = records.filter(r => {
    const cat = classifyRecord(r.name);
    const cs = categoryStats[cat] || { median: 0, avg: 0 };
    const h = history[r.province + ':' + r.proId];
    const a = analyzeRecord(r, cs.median, cs.avg, h);
    // 条件：正在报价 + 低价(≤30%) + 即将截止(≤14天)
    return r.proStage === '正在报价' && a.pricePercentile <= 30 && a.days !== null && a.days <= 14 && r.price > 0;
  }).sort((a, b) => {
    // 按紧迫度排序：剩余天数越少越靠前
    const endA = a.endDate ? new Date(a.endDate.replace(/\//g, '-')) : null;
    const endB = b.endDate ? new Date(b.endDate.replace(/\//g, '-')) : null;
    const daysA = endA ? Math.ceil((endA - new Date()) / (1000 * 60 * 60 * 24)) : 999;
    const daysB = endB ? Math.ceil((endB - new Date()) / (1000 * 60 * 60 * 24)) : 999;
    return daysA - daysB;
  }).slice(0, 50);

  if (bargainItems.length > 0) {
    html += `<div class="s2" style="margin-top:32px;color:#c62828">捡漏清单 <em style="color:#c62828">${bargainItems.length} 项 — 低价+即将截止+正在报价</em></div>`;
    html += `<div style="overflow-x:auto;max-height:400px;overflow-y:auto;margin-bottom:16px;border-radius:8px;border:1px solid #ffcdd2">`;
    html += `<table style="background:#fff"><tr><th>#</th><th>省份</th><th>项目名称</th><th>挂牌价格</th><th>截止日期</th><th>剩余</th><th>价格百分位</th><th>解析</th></tr>`;
    bargainItems.forEach((r, i) => {
      const cat = classifyRecord(r.name);
      const cs = categoryStats[cat] || { median: 0, avg: 0 };
      const a = analyzeRecord(r, cs.median, cs.avg, history[r.province + ':' + r.proId]);
      const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
      const insightHtml = a.insights.map(ins => `<span style="color:${ins.color};font-weight:${ins.weight === 'bold' ? 600 : 400};margin-right:4px">${ins.text}</span>`).join('');
      const gpColor = provColors[r.province] || '#888';
      const daysLeft = a.days !== null ? a.days + '天' : '—';
      html += `<tr><td style="color:#aaa">${i + 1}</td><td><span class="tag-prov" style="background:${gpColor}">${r.province}</span></td><td class="n">${r.name.substring(0, 80)}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate}</td><td style="font-size:11px;color:${a.days !== null && a.days <= 3 ? '#c62828' : '#e65100'};font-weight:600">${daysLeft}</td><td style="font-size:11px;color:#1565c0;font-weight:500">${a.pricePercentile}%</td><td style="font-size:11px">${insightHtml}</td></tr>`;
    });
    html += `</table></div>`;
  }

  // 省份均价对比
  html += `<div class="s2">省份均价对比</div><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">`;
  Object.entries(provinceStats).sort((a, b) => (b[1].total/b[1].count) - (a[1].total/a[1].count)).forEach(([pv, info]) => {
    const color = provColors[pv] || '#888';
    const avg = info.count > 0 ? info.total / info.count : 0;
    html += `<div style="background:#fff;padding:8px 12px;border-radius:6px;border:1px solid #e8e8e8;min-width:140px">
      <span class="tag-prov" style="background:${color}">${pv}</span>
      <div style="margin-top:4px;font-size:15px;font-weight:600;color:#1a1a2e">${(avg / 10000).toFixed(2)}万</div>
      <div style="font-size:11px;color:#888;margin-top:2px">${info.count} 项</div>
    </div>`;
  });
  html += `</div>`;

  // 同类资产跨省价格对比（取前5大分类，每个省有≥5条数据的）
  const crossProvinceCats = ['房产', '车辆', '设备/机械', '废旧物资', '企业产权', '艺术品/收藏'];
  html += `<div class="s2">同类资产跨省价格对比</div><div style="display:flex;gap:12px;flex-wrap:wrap;margin-bottom:16px">`;
  crossProvinceCats.forEach(cat => {
    const catItems = records.filter(r => classifyRecord(r.name) === cat && r.price > 0);
    if (catItems.length < 10) return;
    const provData = {};
    catItems.forEach(r => {
      if (!provData[r.province]) provData[r.province] = { prices: [], count: 0 };
      provData[r.province].prices.push(r.price);
      provData[r.province].count++;
    });
    // 只保留≥5条的省份
    const validProvinces = Object.entries(provData).filter(([_, d]) => d.count >= 5);
    if (validProvinces.length < 2) return;
    const maxAvg = Math.max(...validProvinces.map(([_, d]) => d.prices.reduce((a,b) => a+b, 0) / d.prices.length));

    html += `<div style="background:#fff;padding:10px 14px;border-radius:8px;border:1px solid #e8e8e8;min-width:200px;flex:1">
      <div style="font-size:12px;font-weight:600;color:#1a1a2e;margin-bottom:8px">${cat} (${catItems.length} 项)</div>`;
    validProvinces.sort((a, b) => {
      const avgA = a[1].prices.reduce((s,p) => s+p, 0) / a[1].prices.length;
      const avgB = b[1].prices.reduce((s,p) => s+p, 0) / b[1].prices.length;
      return avgB - avgA;
    }).forEach(([pv, d]) => {
      const avg = d.prices.reduce((s,p) => s+p, 0) / d.prices.length;
      const pct = maxAvg > 0 ? (avg / maxAvg * 100) : 0;
      const color = provColors[pv] || '#888';
      html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:11px">
        <span class="tag-prov" style="background:${color};min-width:22px;text-align:center">${pv}</span>
        <span class="bar ${pct > 80 ? 'bar-h' : pct > 50 ? 'bar-m' : 'bar-l'}" style="width:${Math.max(pct, 5)}px;height:10px"></span>
        <span style="color:#1a1a2e;font-weight:500">${(avg / 10000).toFixed(2)}万</span>
        <span style="color:#888">(${d.count}项)</span>
      </div>`;
    });
    html += `</div>`;
  });
  html += `</div>`;

  html += `<div class="s2">价格分布 <em>(${prices.length} 条有价格数据)</em></div>`;
  rangeCounts.forEach(([label, count]) => {
    const pct = maxCount > 0 ? count / maxCount * 100 : 0;
    const barClass = pct > 60 ? 'bar-h' : (pct > 30 ? 'bar-m' : 'bar-l');
    html += `<div style="margin-bottom:4px;font-size:12px"><span style="display:inline-block;width:90px;color:#666">${label}</span><span class="bar ${barClass}" style="width:${Math.max(pct, 2)}px"></span><span style="color:#4a6fa5;margin-left:6px;font-weight:500">${count}</span></div>`;
  });

  // 解析逻辑说明
  html += `<details style="margin:8px 0 24px"><summary style="font-size:11px;color:#aaa;cursor:pointer;padding:4px 8px">· 解析逻辑</summary>
<div style="font-size:11px;color:#666;padding:10px 14px;background:#fafbfc;border:1px solid #eee;border-radius:6px;line-height:1.9">
<div style="margin-bottom:6px"><b style="color:#444">数据源</b>：山东产权交易中心(SD) · 广州产权交易所(GD) · 深圳联合产权交易所(SZ) · 江西省产权交易所(JX) · 西部产权交易所/陕西(SN)</div>
<div style="margin:6px 0"><b style="color:#444">阶段含义</b></div>
<div>· <span style="color:#6b7c93">等待挂牌</span> — 尚未开放</div>
<div>· <span style="color:#e89500">正在报名</span> — <b>无人出价</b></div>
<div>· <span style="color:#2e7d32">正在报价</span> — <b>已有人出价</b></div>
<div>· <span style="color:#1565c0">已成交</span> — 交易已完成</div>
<div>· <span style="color:#999">已终结</span> — 挂牌已终止</div>
<div style="margin:8px 0 6px"><b style="color:#444">价格竞争力</b></div>
<div>· 底价(≤15%) / 低价(≤30%) / 偏高(≥70%) / 高估值(≥85%) — 基于同分类价格中位数百分位</div>
<div style="margin:8px 0 6px"><b style="color:#444">挂牌周期</b></div>
<div>· 挂牌初期(≤30%) / 中期(30-70%) / 后期(70-90%) / 末期(≥90%) — 已过天数/总天数</div>
<div style="margin:8px 0 6px"><b style="color:#444">畅销度</b></div>
<div>· 秒配(≤1天出价) / 速配(≤3天) / 畅销(≤7天) / 有人出价(&gt;7天)</div>
<div style="margin:8px 0 6px"><b style="color:#444">急迫度</b></div>
<div>· 今日截止 / 紧急(≤3天) / 临近(≤7天) / 两周内(≤14天)</div>
<div style="margin:8px 0 6px"><b style="color:#444">滞销预警</b></div>
<div>· 挂牌超30天 / 超60天 — 首次发现至今未成交</div>
<div style="margin-top:8px;color:#999;font-size:10px">价格统一为元。各省状态已归一化。历史数据通过 history.json 追踪。过期项目自动标记为已终结。</div>
</div></details>`;

  // 资产分类统计
  html += `<div class="s2">资产分类统计</div>`;
  html += `<div style="display:flex;gap:12px;flex-wrap:wrap">`;
  Object.entries(categories).sort((a, b) => b[1].length - a[1].length).forEach(([cat, items]) => {
    const catPrices = items.map(r => r.price).filter(p => p > 0);
    const catTotal = catPrices.reduce((a, b) => a + b, 0);
    const catAvg = catPrices.length ? Math.round(catTotal / catPrices.length) : 0;
    const tagClass = cat === '房产' ? 'tag-blue' : cat === '车辆' ? 'tag-orange' : cat === '金融资产' ? 'tag-green' : 'tag-grey';
    html += `<div style="background:#fff;padding:8px 12px;border-radius:6px;border:1px solid #e8e8e8;min-width:140px">`;
    html += `<span class="tag ${tagClass}">${cat}</span>`;
    html += `<div style="margin-top:4px;font-size:15px;font-weight:600;color:#1a1a2e">${items.length} 项</div>`;
    html += `<div style="font-size:11px;color:#888;margin-top:2px">总值 ${(catTotal / 10000).toFixed(0)}万 · 均值 ${(catAvg / 10000).toFixed(2)}万</div></div>`;
  });
  html += `</div>`;

  // 批量资产分组
  html += `<div class="s2" style="margin-top:32px">批量资产分组 <em>(${sortedGroups.length} 个主体，共 ${totalBulkItems} 项)</em></div>`;
  sortedGroups.forEach(([entity, items], gi) => {
    const sorted = items.sort((a, b) => b.price - a.price);
    const groupPrices = sorted.map(r => r.price).filter(p => p > 0);
    const groupTotal = groupPrices.reduce((a, b) => a + b, 0);
    const groupMax = Math.max(...groupPrices);
    const groupMin = Math.min(...groupPrices);
    const groupAvg = Math.round(groupTotal / groupPrices.length);
    const groupCats = [...new Set(sorted.map(r => classifyRecord(r.name)))];
    const groupProvinces = [...new Set(sorted.map(r => r.province))];
    const groupStages = {};
    sorted.forEach(r => { groupStages[r.proStage] = (groupStages[r.proStage] || 0) + 1; });

    let location = '';
    const locMatch = sorted[0].name.match(/([^--]+)--/);
    if (locMatch) location = locMatch[1].trim();
    if (!location) location = sorted[0].name.substring(0, 30);

    const gpColor = provColors[groupProvinces[0]] || '#888';

    html += `<div class="group-card">
<div class="group-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
<div class="gicon" style="background:${gpColor}">${items.length}</div>
<div class="gtitle">
<div class="gname">${entity}</div>
<div class="gmeta"><span>${groupCats.join(' / ')}</span><span>${(groupTotal / 10000).toFixed(0)}万总挂</span><span>${(groupMin / 10000).toFixed(1)}~${(groupMax / 10000).toFixed(0)}万</span></div>
</div>
<span class="garrow">▶</span>
</div>
<div class="group-body">
<div class="group-summary">
<div class="gs-item"><span class="gs-num">${items.length}</span><span class="gs-lbl">项数</span></div>
<div class="gs-item"><span class="gs-num">${(groupTotal / 10000).toFixed(0)}万</span><span class="gs-lbl">总挂牌金额</span></div>
<div class="gs-item"><span class="gs-num">${(groupAvg / 10000).toFixed(2)}万</span><span class="gs-lbl">均值</span></div>
<div class="gs-item"><span class="gs-num">${(groupMin / 10000).toFixed(1)}~${(groupMax / 10000).toFixed(0)}万</span><span class="gs-lbl">价格区间</span></div>
<div class="gs-item"><span class="gs-num">${Object.entries(groupStages).map(([k, v]) => v + k).join(' ')}</span><span class="gs-lbl">阶段分布</span></div>
</div>
<table class="group-table"><tr><th>#</th><th>省份</th><th>编号</th><th>位置/名称</th><th>挂牌价格</th><th>截止日期</th><th>剩余</th><th>状态</th><th>解析</th></tr>`;
    sorted.forEach((r, i) => {
      const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
      const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : r.proStage === '正在报价' ? 'st2' : r.proStage === '已成交' ? 'st3' : 'st4');
      const cat = classifyRecord(r.name);
      const cs = categoryStats[cat] || { median: 0, avg: 0 };
      const a = analyzeRecord(r, cs.median, cs.avg, history[r.province + ':' + r.proId]);
      let displayName = r.name;
      const dnMatch = r.name.match(/^([^--]+)/);
      if (dnMatch) displayName = dnMatch[1].trim();
      if (displayName.length > 50) displayName = displayName.substring(0, 50) + '...';
      const codeShort = r.code.length > 10 ? r.code.substring(0, 8) + '..' : r.code;
      const insightHtml = a.insights.map(ins => `<span style="color:${ins.color};font-weight:${ins.weight === 'bold' ? 600 : 400};margin-right:4px">${ins.text}</span>`).join('');
      const gpColor2 = provColors[r.province] || '#888';
      html += `<tr><td style="color:#aaa">${i + 1}</td><td><span class="tag-prov" style="background:${gpColor2}">${r.province}</span></td><td style="font-size:10px;color:#aaa;cursor:help" title="${r.code}">${codeShort}</td><td class="n">${displayName}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate}</td><td style="font-size:11px;color:${a.days !== null && a.days <= 3 ? '#c62828' : a.days !== null && a.days <= 7 ? '#e65100' : '#666'};font-weight:500">${a.days !== null ? a.days + '天' : '—'}</td><td><span class="st ${stageClass}">${r.proStage}</span></td><td style="font-size:11px">${insightHtml}</td></tr>`;
    });
    html += `</table></div></div>`;
  });

  // 独立项目
  const sortedStandalone = standalone.sort((a, b) => b.price - a.price);
  html += `<div class="s2" style="margin-top:32px">独立项目 <em>(${sortedStandalone.length} 项)</em></div>`;
  html += `<div style="overflow-x:auto;max-height:500px;overflow-y:auto">`;
  html += `<table><tr><th>#</th><th>省份</th><th>编号</th><th>项目名称</th><th>挂牌价格</th><th>截止日期</th><th>剩余</th><th>状态</th><th>解析</th><th>分类</th></tr>`;
  sortedStandalone.forEach((r, i) => {
    const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
    const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : r.proStage === '正在报价' ? 'st2' : r.proStage === '已成交' ? 'st3' : 'st4');
    const cat = classifyRecord(r.name);
    const tagClass = cat === '房产' ? 'tag-blue' : cat === '车辆' ? 'tag-orange' : cat === '金融资产' ? 'tag-green' : 'tag-grey';
    const cs = categoryStats[cat] || { median: 0, avg: 0 };
    const a = analyzeRecord(r, cs.median, cs.avg, history[r.province + ':' + r.proId]);
    const codeShort = r.code.length > 10 ? r.code.substring(0, 8) + '..' : r.code;
    const insightHtml = a.insights.map(ins => `<span style="color:${ins.color};font-weight:${ins.weight === 'bold' ? 600 : 400};margin-right:4px">${ins.text}</span>`).join('');
    const gpColor = provColors[r.province] || '#888';
    html += `<tr><td style="color:#aaa">${i + 1}</td><td><span class="tag-prov" style="background:${gpColor}">${r.province}</span></td><td style="font-size:10px;color:#aaa;cursor:help" title="${r.code}">${codeShort}</td><td class="n">${r.name.substring(0, 80)}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate}</td><td style="font-size:11px;color:${a.days !== null && a.days <= 3 ? '#c62828' : a.days !== null && a.days <= 7 ? '#e65100' : '#666'};font-weight:500">${a.days !== null ? a.days + '天' : '—'}</td><td><span class="st ${stageClass}">${r.proStage}</span></td><td style="font-size:11px">${insightHtml}</td><td><span class="tag ${tagClass}">${cat}</span></td></tr>`;
  });
  html += `</table></div>`;

  // 全量分类汇总
  html += `<div class="s2" style="margin-top:32px">全量分类汇总</div>`;
  Object.entries(categories).sort((a, b) => b[1].length - a[1].length).forEach(([cat, items]) => {
    const sorted = items.sort((a, b) => b.price - a.price);
    const tagClass = cat === '房产' ? 'tag-blue' : cat === '车辆' ? 'tag-orange' : cat === '金融资产' ? 'tag-green' : 'tag-grey';
    html += `<details style="margin-bottom:8px"><summary style="padding:8px 12px;background:#fff;border-radius:6px;border:1px solid #e8e8e8;font-size:13px;font-weight:500;color:#1a1a2e;cursor:pointer;display:flex;align-items:center;gap:8px"><span class="tag ${tagClass}">${cat}</span><span>${items.length} 项</span><span style="color:#888;font-weight:400;font-size:12px">点击展开</span></summary>`;
    html += `<div style="overflow-x:auto;max-height:400px;overflow-y:auto;margin-top:4px;border-radius:6px;border:1px solid #e8e8e8">`;
    html += `<table><tr><th>#</th><th>省份</th><th>编号</th><th>项目名称</th><th>挂牌价格</th><th>截止日期</th><th>剩余</th><th>状态</th><th>解析</th></tr>`;
    sorted.forEach((r, i) => {
      const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
      const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : r.proStage === '正在报价' ? 'st2' : r.proStage === '已成交' ? 'st3' : 'st4');
      const cs = categoryStats[cat] || { median: 0, avg: 0 };
      const a = analyzeRecord(r, cs.median, cs.avg, history[r.province + ':' + r.proId]);
      const codeShort = r.code.length > 10 ? r.code.substring(0, 8) + '..' : r.code;
      const insightHtml = a.insights.map(ins => `<span style="color:${ins.color};font-weight:${ins.weight === 'bold' ? 600 : 400};margin-right:4px">${ins.text}</span>`).join('');
      const gpColor = provColors[r.province] || '#888';
      html += `<tr><td style="color:#aaa">${i + 1}</td><td><span class="tag-prov" style="background:${gpColor}">${r.province}</span></td><td style="font-size:10px;color:#aaa;cursor:help" title="${r.code}">${codeShort}</td><td class="n">${r.name.substring(0, 80)}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate}</td><td style="font-size:11px;color:${a.days !== null && a.days <= 3 ? '#c62828' : a.days !== null && a.days <= 7 ? '#e65100' : '#666'};font-weight:500">${a.days !== null ? a.days + '天' : '—'}</td><td><span class="st ${stageClass}">${r.proStage}</span></td><td style="font-size:11px">${insightHtml}</td></tr>`;
    });
    html += `</table></div></details>`;
  });

  html += `<div class="ft"><a href="https://wadesha.github.io/sdcqjy-data-security-report/">·</a></div>`;

  // 搜索/筛选功能
  html += `<script>
(function(){
  // 添加搜索框
  var sb = document.createElement('div');
  sb.style.cssText = 'position:sticky;top:0;z-index:100;background:#f8f9fa;padding:8px 0;margin-bottom:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center';
  sb.innerHTML = '<input id="s" placeholder="搜索项目名称..." style="flex:1;min-width:200px;padding:6px 10px;border:1px solid #d0d0d0;border-radius:4px;font-size:12px;outline:none" oninput="f()">' +
    '<select id="sf" onchange="f()" style="padding:6px 8px;border:1px solid #d0d0d0;border-radius:4px;font-size:12px;background:#fff">' +
    '<option value="">全部阶段</option><option value="正在报价">正在报价</option><option value="正在报名">正在报名</option><option value="等待挂牌">等待挂牌</option><option value="已成交">已成交</option><option value="已终结">已终结</option>' +
    '</select>' +
    '<select id="sp" onchange="f()" style="padding:6px 8px;border:1px solid #d0d0d0;border-radius:4px;font-size:12px;background:#fff">' +
    '<option value="">全部省份</option><option value="SD">山东</option><option value="GD">广州</option><option value="SZ">深圳</option><option value="JX">江西</option><option value="SN">陕西</option>' +
    '</select>' +
    '<span id="sr" style="font-size:11px;color:#888;white-space:nowrap"></span>';
  document.body.insertBefore(sb, document.querySelector('.s2') || document.body.firstChild);

  window.f = function(){
    var q = document.getElementById('s').value.trim().toLowerCase();
    var st = document.getElementById('sf').value;
    var pv = document.getElementById('sp').value;
    var allRows = document.querySelectorAll('table tr');
    var cnt = 0;
    allRows.forEach(function(tr){
      if(!tr.querySelector('td')) return;
      var txt = tr.textContent.toLowerCase();
      var rowProv = '';
      var provTag = tr.querySelector('.tag-prov');
      if(provTag) rowProv = provTag.textContent.trim();
      var rowStage = '';
      var stSpan = tr.querySelector('.st');
      if(stSpan) rowStage = stSpan.textContent.trim();
      var match = true;
      if(q && txt.indexOf(q) < 0) match = false;
      if(st && rowStage !== st) match = false;
      if(pv && rowProv !== pv) match = false;
      tr.style.display = match ? '' : 'none';
      if(match) cnt++;
    });
    document.getElementById('sr').textContent = cnt + ' 条匹配';
  };
})();
</script>`;

  html += `</body></html>`;

  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
  console.log(`\n写入 ${OUTPUT_FILE}, 大小: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, 共 ${records.length} 条记录`);
  console.log(`省份: ${Object.keys(provinceStats).join(', ')}`);
  console.log(`分组: ${sortedGroups.length} 个批量组 (${totalBulkItems} 项), ${standalone.length} 个独立项目`);
  return true;
}

// ============================================================
// 主函数
// ============================================================

async function main() {
  console.log('=== 多省份数据获取脚本 ===');
  console.log(`时间: ${new Date().toISOString()}\n`);

  let allRecords = [];

  // 并行抓取所有省份
  console.log(`并行启动 ${ADAPTERS.length} 个适配器...`);
  const results = await Promise.all(ADAPTERS.map(async (adapter) => {
    console.log(`[${adapter.name}] ${adapter.exchange} 开始获取...`);
    try {
      const records = await adapter.fetchAllRecords();
      console.log(`[${adapter.name}] 完成: ${records.length} 条`);
      return records;
    } catch (e) {
      console.error(`[${adapter.name}] 获取失败: ${e.message}`);
      return [];
    }
  }));

  for (const records of results) allRecords.push(...records);

  console.log(`\n合计: ${allRecords.length} 条记录`);

  // 去重（按 province:proId）
  const unique = [];
  const seen = new Set();
  for (const r of allRecords) {
    const key = r.province + ':' + r.proId;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(r);
    }
  }
  console.log(`去重后: ${unique.length} 条`);

  // 数据清洗
  const { cleaned: cleanRecords, issues } = cleanData(unique);
  console.log(`清洗后: ${cleanRecords.length} 条`);

  // 历史数据
  const history = loadHistory();
  updateHistory(cleanRecords, history);

  generateHTML(cleanRecords, history, issues);
}

main();