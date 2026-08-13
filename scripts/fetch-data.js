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
  // 可以扩展其他分类
  // { categoryId: 'xmpd', typeId: 'cq', label: '产权' },
  // { categoryId: 'xmpd', typeId: 'zz', label: '增资' },
  // { categoryId: 'xmpd', typeId: 'ypl', label: '预披露' },
  // { categoryId: 'xmpd', typeId: 'zl', label: '租赁' },
  // { categoryId: 'xmpd', typeId: 'ssfm', label: '诉讼罚没' },
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
  // 匹配所有行
  const rowRegex = /<tr\s+data-proId="([^"]+)"[\s\S]*?<\/tr>/g;
  let rowMatch;

  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const row = rowMatch[0];
    const proId = rowMatch[1];

    // 提取 onclick 中的 JSON 数据
    const jsonMatch = row.match(/linkToDetail\(\{([^}]+)\}\)/);
    if (!jsonMatch) continue;

    try {
      // 修复 JSON 格式
      let jsonStr = '{' + jsonMatch[1] + '}';
      // 替换 HTML 实体
      jsonStr = jsonStr.replace(/&#34;/g, '"').replace(/&#39;/g, "'");
      const obj = JSON.parse(jsonStr);

      // 提取显示文本
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

        // 检查是否重复（第一页的数据）
        if (page > 1 && allRecords.some(r => r.proId === records[0].proId)) {
          console.log(`[${cat.label}] 第 ${page} 页数据重复，结束`);
          break;
        }

        allRecords = allRecords.concat(records);
        console.log(`[${cat.label}] 第 ${page} 页: ${records.length} 条，累计: ${allRecords.length} 条`);
        page++;
        retryCount = 0;

        // 避免请求过快
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
  const medianPrice = prices.sort((a, b) => a - b)[Math.floor(prices.length / 2)];

  let html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>dv</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#090a0b;color:#999;font-family:SFMono-Regular,Consolas,"Liberation Mono",Menlo,monospace;font-size:10.5px;line-height:1.5;padding:16px;max-width:1600px;margin:0 auto}
.h{color:#444;font-size:12px;margin-bottom:4px;border-bottom:1px solid #111;padding-bottom:8px}.h span{color:#2a2a2a}
.m{color:#333;font-size:10px;margin-bottom:16px;line-height:1.8}
.m span{color:#555;margin-right:12px}
.s2{color:#555;font-size:11px;margin-bottom:8px;padding:4px 0;border-bottom:1px solid #0f0f0f;margin-top:20px}
.s2 em{color:#3a3a3a;font-style:normal;font-size:10px}
table{width:100%;border-collapse:collapse;font-size:10px;margin-bottom:4px}
th{text-align:left;padding:3px 5px;color:#555;font-weight:400;border-bottom:1px solid #181818;background:#0c0c0c;font-size:9px;position:sticky;top:0}
td{padding:3px 5px;border-bottom:1px solid #0e0e0e;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px}
tr:hover td{color:#aaa;background:#0d0d0d}
.n{color:#666}
.p{color:#5a5a5a}
.ft{color:#333;font-size:10px;margin-top:24px;padding-top:12px;border-top:1px solid #111;text-align:center}
.ft a{color:#333;text-decoration:none}
.ft a:hover{color:#555}
.st{display:inline-block;padding:1px 6px;border-radius:2px;font-size:9px;color:#666}
.st0{background:#1a1a1a;color:#777}
.st1{background:#1a1a1a;color:#8a8a8a}
.st2{background:#1a1a1a;color:#9a9a9a}
.bar{display:inline-block;height:10px;background:#1a1a1a;margin-right:4px;vertical-align:middle;border-radius:1px}
.bar-l{background:#2a2a2a}
.bar-m{background:#333}
.bar-h{background:#444}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px;margin-bottom:12px}
.card{background:#0c0c0c;padding:8px 10px;border-radius:3px;border:1px solid #111}
.card .num{font-size:18px;color:#555;display:block}
.card .lbl{font-size:9px;color:#444;display:block;margin-top:2px}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:#0a0a0a}
::-webkit-scrollbar-thumb{background:#1a1a1a;border-radius:2px}
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
<div class="card"><span class="num">${now}</span><span class="lbl">数据更新日期</span></div>
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

  html += `<div class="s2">/* 价格分布 */ <em>(${prices.length} 条有价格数据)</em></div>`;
  rangeCounts.forEach(([label, count]) => {
    const pct = count / maxCount * 100;
    const barClass = pct > 60 ? 'bar-h' : (pct > 30 ? 'bar-m' : 'bar-l');
    html += `<div style="margin-bottom:3px;font-size:9.5px"><span style="display:inline-block;width:80px;color:#555">${label}</span><span class="bar ${barClass}" style="width:${Math.max(pct, 2)}px"></span><span style="color:#666;margin-left:4px">${count}</span></div>`;
  });

  // 分类统计
  const categories = {};
  records.forEach(r => {
    const cat = classifyRecord(r.name);
    if (!categories[cat]) categories[cat] = [];
    categories[cat].push(r);
  });

  html += `<div class="s2">/* 资产分类统计 */</div>`;
  Object.entries(categories).sort((a, b) => b[1].length - a[1].length).forEach(([cat, items]) => {
    const catPrices = items.map(r => r.price).filter(p => p > 0);
    const catTotal = catPrices.reduce((a, b) => a + b, 0);
    const catAvg = catPrices.length ? Math.round(catTotal / catPrices.length) : 0;
    html += `<div style="margin-bottom:2px;font-size:9.5px">`;
    html += `<span style="display:inline-block;width:110px;color:#555">${cat}</span>`;
    html += `<span style="color:#666">${items.length} 项</span>`;
    html += `<span style="color:#555;margin-left:8px">总值: ${(catTotal / 10000).toFixed(0)}万</span>`;
    html += `<span style="color:#444;margin-left:8px">均值: ${(catAvg / 10000).toFixed(2)}万</span>`;
    html += `</div>`;
  });

  // 渲染表格
  function renderTable(records, label) {
    let h = `<div class="s2">/* ${label} */ <em>(${records.length} 条)</em></div>`;
    h += `<div style="overflow-x:auto;max-height:350px;overflow-y:auto">`;
    h += `<table><tr><th>#</th><th>编号</th><th>项目名称</th><th>挂牌价格</th><th>截止日期</th><th>状态</th><th>分类</th></tr>`;
    records.forEach((r, i) => {
      const priceStr = r.price >= 10000 ? (r.price / 10000).toFixed(r.price % 10000 === 0 ? 0 : 2) + '万元' : r.price + '元';
      const stageClass = r.proStage === '等待挂牌' ? 'st0' : (r.proStage === '正在报名' ? 'st1' : 'st2');
      h += `<tr><td>${i + 1}</td><td>${r.code}</td><td class="n">${r.name.substring(0, 80)}</td><td class="p">${priceStr}</td><td>${r.endDate.replace(/\//g, '-')}</td><td><span class="st ${stageClass}">${r.proStage}</span></td><td>${classifyRecord(r.name)}</td></tr>`;
    });
    h += `</table></div>`;
    return h;
  }

  // 按分类
  html += `<div class="s2" style="margin-top:28px;font-size:13px;color:#666;border-bottom-color:#181818">== 按资产分类明细 ==</div>`;
  Object.entries(categories).sort((a, b) => b[1].length - a[1].length).forEach(([cat, items]) => {
    html += renderTable(items.sort((a, b) => b.price - a.price), cat);
  });

  // 按批量资产分组
  html += `<div class="s2" style="margin-top:28px;font-size:13px;color:#666;border-bottom-color:#181818">== 批量资产分组 ==</div>`;
  const entityMap = {};
  records.forEach(r => {
    const m = r.name.match(/--(.+?)(?:所属|$)/);
    const key = m ? m[1].trim() : r.name.split('--')[0].trim();
    if (!entityMap[key]) entityMap[key] = [];
    entityMap[key].push(r);
  });
  Object.entries(entityMap).filter(([k, v]) => v.length >= 3).sort((a, b) => b[1].length - a[1].length).forEach(([entity, items]) => {
    html += renderTable(items.sort((a, b) => b.price - a.price), entity + '  (' + items.length + '项)');
  });

  // Footer
  const repoUrl = 'https://wadesha.github.io/sdcqjy-data-security-report/';
  html += `<div class="ft"><a href="${repoUrl}">.</a></div>`;
  html += `</body></html>`;

  fs.writeFileSync(OUTPUT_FILE, html, 'utf-8');
  console.log(`\n写入 ${OUTPUT_FILE}, 大小: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, 共 ${records.length} 条记录`);
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