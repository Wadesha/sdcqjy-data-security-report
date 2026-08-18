#!/usr/bin/env node
/**
 * 抓取新发现的产权交易所数据 v2
 * 目标：沈阳、福建、青海、宁夏、河南
 */
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execSync } = require('child_process');

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const agent = isHttps ? https : http;
    
    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeout: 20000,
      rejectUnauthorized: false,
    };

    if (PROXY_URL) {
      try {
        const p = new URL(PROXY_URL);
        // HTTP proxy for HTTP, CONNECT tunnel for HTTPS
        if (!isHttps) {
          options.hostname = p.hostname;
          options.port = p.port || 80;
          options.path = url;
          options.headers['Host'] = u.hostname;
        }
      } catch(e) {}
    }

    const req = agent.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// Use curl for HTTP sites (works better with proxy)
function curlFetch(url) {
  try {
    const result = execSync(`curl -sL --connect-timeout 10 --max-time 20 "${url}" 2>/dev/null`, {
      encoding: 'utf-8',
      timeout: 25000,
    });
    return result;
  } catch(e) {
    throw new Error(`curl failed: ${e.message}`);
  }
}

// ============ 沈阳联合产权交易所 ============
async function scrapeShenyang() {
  const projects = [];
  const totalPages = 161;
  
  for (let pi = 0; pi < totalPages; pi++) {
    try {
      let url;
      if (pi === 0) {
        url = 'http://www.sprtc.com/gghz1/xmgg.htm';
      } else {
        // Page 2 = xmgg/160.htm, page 3 = xmgg/159.htm, ..., page 161 = xmgg/1.htm
        const pageNum = totalPages - pi;
        url = `http://www.sprtc.com/gghz1/xmgg/${pageNum}.htm`;
      }
      
      const html = curlFetch(url);
      
      // Extract <p> items with project names
      const pItems = html.match(/<p>\((\d+)\)(.+?)<\/p>/g) || [];
      const dateSpans = html.match(/<span class="date">(\d{4}-\d{2}-\d{2})<\/span>/g) || [];
      
      for (let i = 0; i < pItems.length; i++) {
        const pMatch = pItems[i].match(/<p>\((\d+)\)(.+?)<\/p>/);
        const dateMatch = dateSpans[i] ? dateSpans[i].match(/<span class="date">(\d{4}-\d{2}-\d{2})<\/span>/) : null;
        
        if (pMatch) {
          projects.push({
            no: pMatch[1],
            name: pMatch[2].trim(),
            price: '',
            listDate: dateMatch ? dateMatch[1] : '',
            source: '沈阳联合产权交易所',
            status: '挂牌中'
          });
        }
      }
      
      if (pi % 20 === 0) console.log(`  沈阳: 第${pi+1}/${totalPages}页, 已获取${projects.length}条`);
    } catch (e) {
      console.log(`  沈阳 第${pi+1}页失败: ${e.message}`);
    }
  }
  return projects;
}

// ============ 福建产权交易中心 ============
async function scrapeFujian() {
  const projects = [];
  // Use curl since the site is HTTP-based
  const categories = [
    { url: 'http://www.fjcqjy.com/html/list-content-97w9z6jgi19c287sts0z.html', name: '国有产股权' },
    { url: 'http://www.fjcqjy.com/html/list-content-l37982dl164l39htz112.html', name: '实物资产' },
    { url: 'http://www.fjcqjy.com/html/list-content-4n3y18347bt227rw7soh.html', name: '金融资产' },
    { url: 'http://www.fjcqjy.com/html/list-content-lb68bu39ek692lh6tyi2.html', name: '承包租赁' },
    { url: 'http://www.fjcqjy.com/html/list-content-9k0341s99yd4d5qywty9.html', name: '增资扩股' },
  ];

  for (const cat of categories) {
    try {
      let pageUrl = cat.url;
      for (let page = 0; page < 5; page++) { // max 5 pages per category
        const html = curlFetch(pageUrl);
        
        // Look for table rows with project data
        const rows = html.match(/<tr[^>]*>[\s\S]*?<td[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>[\s\S]*?<\/tr>/g) || [];
        
        if (rows.length === 0) {
          // Try simpler pattern
          const links = html.match(/<a[^>]*href="[^"]*"[^>]*>([^<]{10,})<\/a>/g) || [];
          for (const link of links) {
            const name = link.replace(/<[^>]+>/g, '').trim();
            if (name.length > 5 && !name.includes('首页') && !name.includes('项目频道') && !name.includes('搜索')) {
              const dateMatch = html.match(/<span[^>]*class="[^"]*date[^"]*"[^>]*>(\d{4}[-/]\d{2}[-/]\d{2})<\/span>/);
              projects.push({
                no: '',
                name: name,
                price: '',
                listDate: dateMatch ? dateMatch[1] : '',
                source: '福建产权交易中心',
                status: '挂牌中'
              });
            }
          }
        }
        
        // Check for next page
        const nextPage = html.match(/<a[^>]*href="([^"]*page[^"]*)"[^>]*>下一页<\/a>/i) || 
                         html.match(/<a[^>]*href="([^"]*)"[^>]*>下页<\/a>/i);
        if (nextPage) {
          pageUrl = 'http://www.fjcqjy.com' + nextPage[1];
        } else {
          break;
        }
      }
    } catch (e) {
      console.log(`  福建 ${cat.name} 失败: ${e.message}`);
    }
  }
  return projects;
}

// ============ 青海产权交易市场 ============
async function scrapeQinghai() {
  const projects = [];
  const categories = [
    { code: '3001', name: '竞价公告' },
    { code: '3002', name: '国资挂牌' },
    { code: '3009', name: '民营项目' },
  ];
  
  for (const cat of categories) {
    try {
      for (let page = 1; page <= 10; page++) {
        const url = `http://www.qhcqjy.com/item.do?para=viewlist&classCode=${cat.code}&pageNo=${page}`;
        const raw = curlFetch(url);
        // Convert GB2312 to UTF-8
        const utf8 = execSync(`echo "${raw.replace(/"/g, '\\"')}" | iconv -f gb2312 -t utf-8 2>/dev/null || echo "${raw}"`, { encoding: 'utf-8', timeout: 5000 });
        
        // Extract project items from the list
        const items = utf8.match(/<a[^>]*href="[^"]*item\.do\?para=view[^"]*"[^>]*>([^<]+)<\/a>/g) || [];
        for (const item of items) {
          const name = item.replace(/<[^>]+>/g, '').trim();
          if (name.length > 5 && !name.includes('更多') && !name.includes('首页')) {
            projects.push({
              no: '',
              name: name,
              price: '',
              listDate: '',
              source: '青海产权交易市场',
              status: '挂牌中'
            });
          }
        }
        
        // Check if there's a next page
        if (!utf8.includes('下一页')) break;
      }
    } catch (e) {
      console.log(`  青海 ${cat.name} 失败: ${e.message}`);
    }
  }
  return projects;
}

// ============ 宁夏科技资源与产权交易所 ============
async function scrapeNingxia() {
  const projects = [];
  const seen = new Set();
  
  const categories = [
    { url: 'http://www.ntree.com.cn/article/xm/cqzr/', name: '产权转让' },
    { url: 'http://www.ntree.com.cn/article/xm/zczr/', name: '资产转让' },
    { url: 'http://www.ntree.com.cn/article/xm/zczl/', name: '资产租赁' },
  ];

  for (const cat of categories) {
    try {
      const html = curlFetch(cat.url);
      // Extract project list items - look for links in the list
      const links = html.match(/<a[^>]*href="(\/article\/xm\/[^"]+)"[^>]*>([^<]{8,})<\/a>/g) || [];
      for (const link of links) {
        const nameMatch = link.match(/>([^<]+)</);
        if (nameMatch) {
          const name = nameMatch[1].trim();
          if (!seen.has(name) && name.length > 5 && !name.includes('首页') && !name.includes('搜索') && !name.includes('项目') && !name.includes('指南') && !name.includes('法规') && !name.includes('专栏') && !name.includes('公告') && !name.includes('我们')) {
            seen.add(name);
            projects.push({
              no: '',
              name: name,
              price: '',
              listDate: '',
              source: '宁夏科技资源与产权交易所',
              status: '挂牌中'
            });
          }
        }
      }
    } catch (e) {
      console.log(`  宁夏 ${cat.name} 失败: ${e.message}`);
    }
  }
  return projects;
}

// ============ 主流程 ============
async function main() {
  console.log('开始抓取新交易所数据...\n');

  const results = {};

  console.log('1. 沈阳联合产权交易所 (3,210条, 161页)...');
  results.shenyang = await scrapeShenyang();
  console.log(`  完成: ${results.shenyang.length} 条\n`);

  console.log('2. 福建产权交易中心...');
  results.fujian = await scrapeFujian();
  console.log(`  完成: ${results.fujian.length} 条\n`);

  console.log('3. 青海产权交易市场...');
  results.qinghai = await scrapeQinghai();
  console.log(`  完成: ${results.qinghai.length} 条\n`);

  console.log('4. 宁夏科技资源与产权交易所...');
  results.ningxia = await scrapeNingxia();
  console.log(`  完成: ${results.ningxia.length} 条\n`);

  // 保存各交易所数据
  const saveMap = {
    shenyang: 'sy_projects.json',
    fujian: 'fj_projects.json',
    qinghai: 'qh_projects.json',
    ningxia: 'nx_projects.json',
  };

  let total = 0;
  for (const [key, file] of Object.entries(saveMap)) {
    if (results[key].length > 0) {
      const unique = [];
      const seen = new Set();
      for (const p of results[key]) {
        const k = p.name + p.listDate;
        if (!seen.has(k)) { seen.add(k); unique.push(p); }
      }
      fs.writeFileSync(path.join(__dirname, '..', file), JSON.stringify(unique, null, 2), 'utf-8');
      console.log(`  已保存 ${file}: ${unique.length} 条`);
      total += unique.length;
    }
  }

  console.log(`\n总计: ${total} 条新数据`);
}

main().catch(console.error);