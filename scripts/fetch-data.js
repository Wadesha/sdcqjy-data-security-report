#!/usr/bin/env node
/**
 * 数据获取脚本
 * 从山东产权交易中心获取项目数据，生成 d.html
 *
 * 使用方式: node scripts/fetch-data.js
 * 环境要求: Node.js 18+
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'http://www.sdcqjy.com';
const API_PATH = '/projlist/getdata';
const OUTPUT_FILE = path.join(__dirname, '..', 'd.html');

// 分类配置
const CATEGORIES = [
  { categoryId: 'xmpd', typeId: 'zc', label: '资产' },
];

/**
 * 发起 HTTP POST 请求
 */
function fetchPage(categoryId, typeId, page) {
  return new Promise((resolve, reject) => {
    const body = `categoryId=${categoryId}&typeId=${typeId}&page=${page}&projType=table`;
    const options = {
      hostname: 'www.sdcqjy.com',
      path: API_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `${BASE_URL}/projlist/${categoryId}/${typeId}`,
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 从 HTML 中解析记录
 */
function parseRecords(html) {
  const records = [];
  const rowRegex = /<tr\s+data-proId="([^"]+)"[\s\S]*?<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[0];
    const proId = rowMatch[1];

    const jsonMatch = row.match(/linkToDetail\(\{([^}]+)\}\)/);
    if (!jsonMatch) continue;

    try {
      let jsonStr = '{' + jsonMatch[1] + '}';
      jsonStr = jsonStr.replace(/&#34;/g, '"').replace(/&#39;/g, "'");
      const obj = JSON.parse(jsonStr);

      const codeMatch = row.match(/<td[^>]*class="[^"]*\bcode\b[^>]*>([^<]+)<\/td>/);
      const priceMatch = row.match(/<td[^>]*class="[^"]*\bprice\b[^>]*>([^<]+)<\/td>/);
      const endDateMatch = row.match(/<td[^>]*class="[^"]*\bendDate\b[^>]*>([^<]+)<\/td>/);
      const proStageMatch = row.match(/<td[^>]*class="[^"]*\bproStage\b[^>]*title="([^"]*)"[^>]*>/);

      records.push({
        proId: proId,
        code: obj.code || (codeMatch ? codeMatch[1].trim() : ''),
        name: obj.name || '',
        price: obj.price != null ? obj.price : 0,
        priceStr: priceMatch ? priceMatch[1].trim() : '',
        endDate: obj.endDate || '',
        startDate: obj.startDate || '',
        status: obj.status != null ? obj.status : 0,
        stage: obj.stage != null ? obj.stage : 0,
        proStage: obj.proStage || (proStageMatch ? proStageMatch[1] : ''),
        assetType: obj.assetType || '',
        type: obj.type != null ? obj.type : 0,
        planDealMode: obj.planDealMode,
      });
    } catch (e) {
      // 跳过解析失败的行
    }
  }

  return records;
}

/**
 * 获取所有页面的数据
 */
async function fetchAllData() {
  let allRecords = [];

  for (const cat of CATEGORIES) {
    console.log(`[${cat.label}] 开始获取...`);
    let page = 1;
    let retryCount = 0;

    while (true) {
      try {
        const html = await fetchPage(cat.categoryId, cat.typeId, page);
        const records = parseRecords(html);

        if (records.length === 0) {
          console.log(`[${cat.label}] 第 ${page} 页无数据，结束`);
          break;
        }

        if (page > 1 && allRecords.some(r => r.proId === records[0].proId)) {
          console.log(`[${cat.label}] 第 ${page} 页数据重复，结束`);
          break;
        }

        allRecords = allRecords.concat(records);
        console.log(`[${cat.label}] 第 ${page} 页: ${records.length} 条，累计: ${allRecords.length} 条`);
        page++;
        retryCount = 0;

        await new Promise(r => setTimeout(r, 500 + Math.random() * 500));
      } catch (e) {
        retryCount++;
        if (retryCount >= 3) {
          console.error(`[${cat.label}] 第 ${page} 页获取失败(已重试3次): ${e.message}`);
          break;
        }
        console.log(`[${cat.label}] 第 ${page} 页重试(${retryCount}/3)...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  return allRecords;
}

/**
 * 分类函数
 */
function classifyRecord(name) {
  if (name.includes('房产') || name.includes('用房') || name.includes('住宅') ||
      name.includes('商铺') || name.includes('办公') || name.includes('公寓') ||
      name.includes('房屋') || name.includes('别墅') || name.includes('写字楼')) return '房产';
  if (name.includes('车辆') || name.includes('乘用车') || name.includes('奥迪') ||
      name.includes('帕萨特') || (name.includes('车') && !name.includes('设备'))) return '车辆';
  if (name.includes('设备资产包') || name.includes('生产线') || name.includes('设备') ||
      name.includes('机器') || name.includes('变压器') || name.includes('存货')) return '设备物资';
  if (name.includes('债权') || name.includes('股权') || name.includes('不良贷款')) return '金融资产';
  if (name.includes('土地')) return '土地使用权';
  if (name.includes('加油站') || name.includes('管道') || name.includes('充电站') || name.includes('发电')) return '基础设施';
  if (name.includes('紫砂壶') || name.includes('艺术品') || name.includes('收藏')) return '艺术品/收藏';
  return '其他';
}

/**
 * 提取资产所属主体（用于批量分组）
 */
function extractEntity(name) {
  // 匹配 "xxx--主体名称所属yyy" 或 "主体名称所属yyy"
  const m1 = name.match(/--(.+?)所属/);
  if (m1) return m1[1].trim();
  // 匹配 "主体名称所属yyy"
  const m2 = name.match(/^([^--]+?)所属/);
  if (m2) return m2[1].trim();
  // 匹配 "xxx--主体名称"
  const parts = name.split('--');
  if (parts.length >= 2) return parts[parts.length - 1].trim().substring(0, 30);
  return null;
}

/**
 * 提取资产具体位置/标识（从名称中提取关键信息）
 */
function extractLocation(name) {
  // 尝试提取 "xx号" / "xx室" / "xx栋" 等
  const m = name.match(/^([^--]+)(?:--|$)/);
  return m ? m[1].trim().substring(0, 40) : name.substring(0, 40);
}

/**
 * 生成 d.html
 */
function generateHTML(records) {
  if (records.length === 0) {
    console.error('无数据，不生成 HTML');
    return false;
  }

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

  // ========== 智能分组：按主体聚合 ==========
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

  // 只把 >=3 项的作为批量组，<3 的归入独立项
  const bulkGroups = {};
  Object.entries(entityGroups).forEach(([entity, items]) => {
    if (items.length >= 3) {
      bulkGroups[entity] = items;
    } else {
      items.forEach(r => standalone.push(r));
    }
  });

  // 按组内项数排序
  const sortedGroups = Object.entries(bulkGroups).sort((a, b) => b[1].length - a[1].length);
  const totalBulkItems = sortedGroups.reduce((s, [_, items]) => s + items.length, 0);

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
.ft a:hover{color:#2b5c8f;text-decoration:underline}
.st{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:500}
.st0{background:#e8ecf0;color:#6b7c93}
.st1{background:#fff3e0;color:#e89500}
.st2{background:#e8f5e9;color:#2e7d32}
.bar{display:inline-block;height:12px;background:#e0e0e0;margin-right:4px;vertical-align:middle;border-radius:2px}
.bar-l{background:#90caf9}
.bar-m{background:#42a5f5}
.bar-h{background:#1565c0}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px;margin-bottom:16px}
.card{background:#fff;padding:12px 14px;border-radius:8px;border:1px solid #e8e8e8;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.card .num{font-size:22px;color:#1a1a2e;display:block;font-weight:600}
.card .lbl{font-size:11px;color:#888;display:block;margin-top:4px}
/* 批量资产组卡片 */
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
/* 颜色标签 */
.tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:500}
.tag-blue{background:#e3f2fd;color:#1565c0}
.tag-orange{background:#fff3e0;color:#e65100}
.tag-green{background:#e8f5e9;color:#2e7d32}
.tag-grey{background:#f0f0f0;color:#666}
::-webkit-scrollbar{width:6px;height:6px}
::-webkit-scrollbar-track{background:#f0f0f0}
::-webkit-scrollbar-thumb{background:#c0c0c0;border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:#a0a0a0}
/* 折叠 JS */
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
<div class="card"><span class="num">${sortedGroups.length}组 / ${totalBulkItems}项</span><span class="lbl">批量资产分组</span></div>
</div>`;

  // 价格分布
  const ranges = [
    ['0-10万', 0, 100000],
    ['10-50万', 100000, 500000],
    ['50-100万', 500000, 1000000],
    ['100-500万', 1000000, 5000000],
    ['500-1000万', 5000000, 10000000],
    ['1000-5000万', 10000000, 50000000],
    ['5000万-1亿', 50000000, 100000000],
    ['1亿+', 100000000, Infinity],
  ];
  const rangeCounts = ranges.map(([label, lo, hi]) => [label, prices.filter(p => p >= lo && p < hi).length]);
  const maxCount = Math.max(...rangeCounts.map(([_, c]) => c));

  html += `<div class="s2">价格分布 <em>(${prices.length} 条有价格数据)</em></div>`;
  rangeCounts.forEach(([label, count]) => {
    const pct = count / maxCount * 100;
    const barClass = pct > 60 ? 'bar-h' : (pct > 30 ? 'bar-m' : 'bar-l');
    html += `<div style="margin-bottom:4px;font-size:12px"><span style="display:inline-block;width:90px;color:#666">${label}</span><span class="bar ${barClass}" style="width:${Math.max(pct, 2)}px"></span><span style="color:#4a6fa5;margin-left:6px;font-weight:500">${count}</span></div>`;
  });

  // 资产分类统计
  const categories = {};
  records.forEach(r => {
    const cat = classifyRecord(r.name);
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(r);
  });

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
    html += `<div style="font-size:11px;color:#888;margin-top:2px">总值 ${(catTotal / 10000).toFixed(0)}万 · 均值 ${(catAvg / 10000).toFixed(2)}万</div>`;
    html += `</div>`;
  });
  html += `</div>`;

  // ========== 批量资产分组展示 ==========
  html += `<div class="s2" style="margin-top:32px">批量资产分组 <em>(${sortedGroups.length} 个主体，共 ${totalBulkItems} 项，占总数 ${(totalBulkItems / records.length * 100).toFixed(0)}%)</em></div>`;
  html += `<p style="font-size:12px;color:#888;margin-bottom:16px">同一主体挂牌的多项资产自动聚合为组。点击标题展开明细。</p>`;

  sortedGroups.forEach(([entity, items], gi) => {
    const sorted = items.sort((a, b) => b.price - a.price);
    const groupPrices = sorted.map(r => r.price).filter(p => p > 0);
    const groupTotal = groupPrices.reduce((a, b) => a + b, 0);
    const groupMax = Math.max(...groupPrices);
    const groupMin = Math.min(...groupPrices);
    const groupAvg = Math.round(groupTotal / groupPrices.length);
    const groupCats = [...new Set(sorted.map(r => classifyRecord(r.name)))];
    const groupStages = {};
    sorted.forEach(r => { groupStages[r.proStage] = (groupStages[r.proStage] || 0) + 1; });

    // 提取共同地点
    const firstItem = sorted[0].name;
    let location = '';
    const locMatch = firstItem.match(/([^--]+)--/);
    if (locMatch) location = locMatch[1].trim();
    if (!location) location = firstItem.substring(0, 30);

    html += `<div class="group-card">
<div class="group-header" onclick="this.classList.toggle('open');this.nextElementSibling.classList.toggle('open')">
<div class="gicon">${items.length}</div>
<div class="gtitle">
<div class="gname">${entity}</div>
<div class="gmeta"><span>${groupCats.join(' / ')}</span><span>${(groupTotal / 10000).toFixed(0)}万总挂</span><span>${(groupMin / 10000).toFixed(2)}~${(groupMax / 10000).toFixed(2)}万</span></div>
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
<table class="group-table"><tr><th>#</th><th>编号</th><th>位置/名称</th><th>挂牌价格</th><th>截止日期</th><th>状态</th></tr>`;
    sorted.forEach((r, i) => {
      const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
      const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : 'st2');
      // 提取具体位置
      let displayName = r.name;
      const dnMatch = r.name.match(/^([^--]+)/);
      if (dnMatch) displayName = dnMatch[1].trim();
      if (displayName.length > 50) displayName = displayName.substring(0, 50) + '...';
      html += `<tr><td style="color:#aaa">${i + 1}</td><td style="font-size:11px;color:#888">${r.code}</td><td class="n">${displayName}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate.replace(/\//g, '-')}</td><td><span class="st ${stageClass}">${r.proStage}</span></td></tr>`;
    });
    html += `</table>
</div>
</div>`;
  });

  // ========== 独立项目展示 ==========
  const sortedStandalone = standalone.sort((a, b) => b.price - a.price);
  html += `<div class="s2" style="margin-top:32px">独立项目 <em>(${sortedStandalone.length} 项)</em></div>`;
  html += `<p style="font-size:12px;color:#888;margin-bottom:16px">未归属批量分组的独立挂牌项目，按价格降序排列。</p>`;
  html += `<div style="overflow-x:auto;max-height:500px;overflow-y:auto">`;
  html += `<table><tr><th>#</th><th>编号</th><th>项目名称</th><th>挂牌价格</th><th>截止日期</th><th>状态</th><th>分类</th></tr>`;
  sortedStandalone.forEach((r, i) => {
    const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
    const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : 'st2');
    const cat = classifyRecord(r.name);
    const tagClass = cat === '房产' ? 'tag-blue' : cat === '车辆' ? 'tag-orange' : cat === '金融资产' ? 'tag-green' : 'tag-grey';
    html += `<tr><td style="color:#aaa">${i + 1}</td><td style="font-size:11px;color:#888">${r.code}</td><td class="n">${r.name.substring(0, 80)}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate.replace(/\//g, '-')}</td><td><span class="st ${stageClass}">${r.proStage}</span></td><td><span class="tag ${tagClass}">${cat}</span></td></tr>`;
  });
  html += `</table></div>`;

  // ========== 按分类汇总 ==========
  html += `<div class="s2" style="margin-top:32px">全量分类汇总</div>`;
  Object.entries(categories).sort((a, b) => b[1].length - a[1].length).forEach(([cat, items]) => {
    const sorted = items.sort((a, b) => b.price - a.price);
    const tagClass = cat === '房产' ? 'tag-blue' : cat === '车辆' ? 'tag-orange' : cat === '金融资产' ? 'tag-green' : 'tag-grey';
    html += `<details style="margin-bottom:8px"><summary style="padding:8px 12px;background:#fff;border-radius:6px;border:1px solid #e8e8e8;font-size:13px;font-weight:500;color:#1a1a2e;cursor:pointer;display:flex;align-items:center;gap:8px"><span class="tag ${tagClass}">${cat}</span><span>${items.length} 项</span><span style="color:#888;font-weight:400;font-size:12px">点击展开</span></summary>`;
    html += `<div style="overflow-x:auto;max-height:400px;overflow-y:auto;margin-top:4px;border-radius:6px;border:1px solid #e8e8e8">`;
    html += `<table><tr><th>#</th><th>编号</th><th>项目名称</th><th>挂牌价格</th><th>截止日期</th><th>状态</th></tr>`;
    sorted.forEach((r, i) => {
      const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万' : r.price + '元';
      const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : 'st2');
      html += `<tr><td style="color:#aaa">${i + 1}</td><td style="font-size:11px;color:#888">${r.code}</td><td class="n">${r.name.substring(0, 80)}</td><td class="p">${priceStr}</td><td style="font-size:11px;color:#888">${r.endDate.replace(/\//g, '-')}</td><td><span class="st ${stageClass}">${r.proStage}</span></td></tr>`;
    });
    html += `</table></div></details>`;
  });

  // Footer
  const repoUrl = 'https://wadesha.github.io/sdcqjy-data-security-report/';
  html += `<div class="ft"><a href="${repoUrl}">·</a></div>`;
  html += `</body></html>`;

  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
  console.log(`\n写入 ${OUTPUT_FILE}, 大小: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, 共 ${records.length} 条记录`);
  console.log(`分组: ${sortedGroups.length} 个批量组 (${totalBulkItems} 项), ${standalone.length} 个独立项目`);
  return true;
}

/**
 * 主函数
 */
async function main() {
  console.log('=== 数据获取脚本 ===');
  console.log(`时间: ${new Date().toISOString()}\n`);

  try {
    const records = await fetchAllData();
    console.log(`\n获取完成: 共 ${records.length} 条记录`);

    // 去重
    const unique = [];
    const seen = new Set();
    for (const r of records) {
      if (!seen.has(r.proId)) {
        seen.add(r.proId);
        unique.push(r);
      }
    }
    console.log(`去重后: ${unique.length} 条`);

    generateHTML(unique);
  } catch (e) {
    console.error('脚本执行失败:', e.message);
    process.exit(1);
  }
}

main();
