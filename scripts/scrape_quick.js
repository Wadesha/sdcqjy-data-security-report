#!/usr/bin/env node
/** Quick scrape for 青海 and 宁夏 using curl + iconv */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function curl(url) {
  try {
    return execSync(`curl -sL --connect-timeout 10 --max-time 20 "${url}"`, { encoding: 'binary', timeout: 25000 });
  } catch(e) { return ''; }
}

// ========== 青海 ==========
function scrapeQinghai() {
  const projects = [];
  const codes = ['3001', '3002', '3009'];
  for (const code of codes) {
    for (let page = 1; page <= 107; page++) {
      const url = `http://www.qhcqjy.com/item.do?para=viewlist&classCode=${code}&pageNo=${page}`;
      const raw = curl(url);
      if (!raw) break;
      // Save raw binary to temp file, convert with iconv
      fs.writeFileSync('/tmp/qh_raw.htm', raw, 'binary');
      let utf8;
      try {
        utf8 = execSync('iconv -f gb2312 -t utf-8 /tmp/qh_raw.htm 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      } catch(e) { break; }
      
      // Extract table rows with project data
      // Pattern: <TD class=tab_xw2><A href="/item.do?para=viewcontent&id=XXXX">NAME</A>
      const items = utf8.match(/<TD class=tab_xw2>[\s\S]*?<A[\s\S]*?href="[^"]*viewcontent[^"]*"[\s\S]*?target=_blank>([^<]+)<\/A>[\s\S]*?<\/TD>[\s\S]*?<TD[^>]*>([^<]*)<\/TD>[\s\S]*?<TD[^>]*>([^<]*)<\/TD>[\s\S]*?<TD[^>]*>([^<]*)<\/TD>/g) || [];
      for (const item of items) {
        const name = item.match(/target=_blank>([^<]+)<\/A>/);
        const ind = item.match(/<TD class="tab_xw1">([^<]*)<\/TD>/);
        const price = item.match(/<TD[^>]*class="[^"]*tab_xw3[^"]*"[^>]*>([^<]*)<\/TD>/);
        const date = item.match(/<TD[^>]*class=tab_xw1[^>]*align=right[^>]*>([^<]*)<\/TD>/);
        if (name) {
          projects.push({
            name: name[1].trim(),
            price: price ? price[1].trim() : '',
            listDate: date ? date[1].trim() : '',
            source: '青海产权交易市场',
          });
        }
      }
      
      if (!utf8.includes('pageNo=' + (page + 1))) break;
      if (page % 10 === 0) process.stderr.write(`青海 code=${code} page ${page}: ${projects.length} items\n`);
    }
  }
  return projects;
}

// ========== 宁夏 ==========
function scrapeNingxia() {
  const projects = [];
  const seen = new Set();
  const cats = [
    '/article/xm/cqzr/zspl/',
    '/article/xm/cqzr/ypl/',
    '/article/xm/zczr/zspl.shtml',
    '/article/xm/zczr/ypl/',
    '/article/xm/zczl/xmpl.shtml',
    '/article/xm/qyzz/zspl/',
  ];
  for (const cat of cats) {
    const html = curl(`http://www.ntree.com.cn${cat}`);
    // Find project item links
    const links = html.match(/<a[^>]*href="([^"]+)"[^>]*target="_blank">([^<]{8,})<\/a>/g) || [];
    for (const link of links) {
      const m = link.match(/href="([^"]+)"[^>]*target="_blank">([^<]+)<\/a>/);
      if (m) {
        const name = m[2].trim();
        if (!seen.has(name) && !name.includes('首页') && !name.includes('搜索') && !name.includes('关于') && !name.includes('法律')) {
          seen.add(name);
          projects.push({ name, price: '', listDate: '', source: '宁夏科技资源与产权交易所' });
        }
      }
    }
  }
  return projects;
}

const qh = scrapeQinghai();
fs.writeFileSync(path.join(__dirname, '..', 'qh_projects.json'), JSON.stringify(qh, null, 2));
console.log(`青海: ${qh.length} 条`);

const nx = scrapeNingxia();
fs.writeFileSync(path.join(__dirname, '..', 'nx_projects.json'), JSON.stringify(nx, null, 2));
console.log(`宁夏: ${nx.length} 条`);