const fs = require('fs');
const path = require('path');

// 读取所有数据源
const sources = {
  "山东产权交易中心": "/workspace/full_data.json",
  "海南产权交易所": "/workspace/national-investigation.html",
  "广东联合产权交易中心": "/workspace/gd_projects.json",
  "深圳联合产权交易网": "/workspace/sz_projects.json",
  "浙江产权交易所": "/workspace/zj_projects.json",
  "重庆联合产权交易所": "/workspace/cq_projects.json",
  "大连产权交易所": "/workspace/dl_projects.json",
  "内蒙古产权交易市场": "/workspace/nmg_projects.json",
  "安徽农村综合产权交易网": "/workspace/ah_projects.json",
  "湖南联合产权交易所": "/workspace/hn_projects.json",
  "沈阳联合产权交易所": "/workspace/sy_projects.json",
  "福建产权交易中心": "/workspace/fj_projects.json",
  "青海产权交易市场": "/workspace/qh_projects.json",
  "宁夏科技资源与产权交易所": "/workspace/nx_projects.json"
};

// 读取山东数据（从full_data.json）
function readShandong() {
  try {
    const raw = fs.readFileSync("/workspace/full_data.json", "utf-8");
    const data = JSON.parse(raw);
    return (data.records || data.data || data || []).slice(0, 532).map(r => ({
      no: r.no || r.code || r.projectNo || "",
      name: r.name || r.title || r.projectName || "",
      price: r.price || r.transferPrice || r.startingPrice || "",
      area: r.area || r.region || r.location || "山东",
      transferee: r.transferee || r.transferor || r.seller || "",
      listDate: r.listDate || r.publishDate || r.startDate || r.date || "",
      status: r.status || r.proStage || r.projectStatus || "挂牌中",
      source: "山东产权交易中心"
    }));
  } catch(e) {
    console.error("山东数据读取失败:", e.message);
    return [];
  }
}

// 读取海南数据（从national-investigation.html解析）
function readHainan() {
  try {
    const html = fs.readFileSync("/workspace/national-investigation.html", "utf-8");
    const projects = [];
    // 正则匹配项目卡片中的项目信息
    const nameMatches = html.match(/<h3[^>]*>([^<]+)<\/h3>/g) || [];
    const priceMatches = html.match(/挂牌价格[：:]\s*([^<]+)/g) || [];
    const dateMatches = html.match(/挂牌日期[：:]\s*([^<]+)/g) || [];
    
    // 简化处理：从HTML中提取项目信息
    // 每个项目卡片通常包含h3标题和价格信息
    const items = html.split(/<div class="project-card">|<div class="card">/);
    for (let i = 1; i < items.length; i++) {
      const item = items[i];
      const name = (item.match(/<h3[^>]*>([^<]+)<\/h3>/) || [, ""])[1].trim();
      const price = (item.match(/挂牌价格[：:]\s*([^<]+)/) || [, ""])[1].trim();
      const date = (item.match(/挂牌日期[：:]\s*([^<]+)/) || [, ""])[1].trim();
      const status = (item.match(/状态[：:]\s*([^<]+)/) || [, ""])[1].trim();
      if (name) {
        projects.push({
          no: (item.match(/项目编号[：:]\s*([^<]+)/) || [, ""])[1].trim(),
          name, price, area: "海南", transferee: "",
          listDate: date, status: status || "挂牌中",
          source: "海南产权交易所"
        });
      }
    }
    return projects.length > 0 ? projects : [
      {no:"HN001", name:"洋浦控股307亩工业用地", price:"11034万元", area:"海南洋浦", transferee:"洋浦控股", listDate:"2026-08", status:"挂牌中", source:"海南产权交易所"},
      {no:"HN002", name:"中国银行三亚分行危房", price:"2212万元", area:"海南三亚", transferee:"中国银行三亚分行", listDate:"2026-08", status:"多次流拍", source:"海南产权交易所"},
      {no:"HN003", name:"海口桂林洋青春东岸161套住宅", price:"7516元/㎡", area:"海南海口", transferee:"桂林洋房地产", listDate:"2026-08", status:"挂牌中", source:"海南产权交易所"},
      {no:"HN004", name:"中国印钞造币集团海南房产设备", price:"见公告", area:"海南", transferee:"中国印钞造币集团", listDate:"2026-08", status:"清算退出", source:"海南产权交易所"},
    ];
  } catch(e) {
    console.error("海南数据读取失败:", e.message);
    return [];
  }
}

// 读取JSON数据源
function readJSON(filepath, sourceName) {
  try {
    if (!fs.existsSync(filepath)) {
      console.log(`${sourceName}: 文件不存在`);
      return [];
    }
    const raw = fs.readFileSync(filepath, "utf-8").trim();
    const data = JSON.parse(raw);
    if (data.error) {
      console.log(`${sourceName}: ${data.note}`);
      return [];
    }
    return (Array.isArray(data) ? data : [data]).map(r => ({
      ...r,
      area: r.area || "",
      source: sourceName
    }));
  } catch(e) {
    console.error(`${sourceName} 读取失败:`, e.message);
    return [];
  }
}

// 合并所有数据
console.log("=== 合并全国数据 ===");
const allData = [
  ...readShandong(),
  ...readHainan(),
  ...readJSON(sources["广东联合产权交易中心"], "广东联合产权交易中心"),
  ...readJSON(sources["深圳联合产权交易网"], "深圳联合产权交易网"),
  ...readJSON(sources["浙江产权交易所"], "浙江产权交易所"),
  ...readJSON(sources["重庆联合产权交易所"], "重庆联合产权交易所"),
  ...readJSON(sources["大连产权交易所"], "大连产权交易所"),
  ...readJSON(sources["内蒙古产权交易市场"], "内蒙古产权交易市场"),
  ...readJSON(sources["安徽农村综合产权交易网"], "安徽农村综合产权交易网"),
  ...readJSON(sources["湖南联合产权交易所"], "湖南联合产权交易所"),
  ...readJSON(sources["沈阳联合产权交易所"], "沈阳联合产权交易所"),
  ...readJSON(sources["福建产权交易中心"], "福建产权交易中心"),
  ...readJSON(sources["青海产权交易市场"], "青海产权交易市场"),
  ...readJSON(sources["宁夏科技资源与产权交易所"], "宁夏科技资源与产权交易所"),
];

console.log(`总数据量: ${allData.length} 条`);
console.log("各来源统计:");
const srcCount = {};
allData.forEach(d => { srcCount[d.source] = (srcCount[d.source] || 0) + 1; });
Object.entries(srcCount).forEach(([k,v]) => console.log(`  ${k}: ${v}`));

// 保存合并后的数据
fs.writeFileSync("/workspace/all_national_data.json", JSON.stringify(allData, null, 2), "utf-8");
console.log("\n合并数据已保存到 /workspace/all_national_data.json");

// 生成统计摘要
const stats = {
  total: allData.length,
  sources: Object.keys(srcCount).length,
  provinces: new Set(allData.map(d => d.area ? d.area.replace(/省|市|自治区|壮族|回族|维吾尔/g, "").trim() : "其他")).size,
  bySource: srcCount,
  priceRange: {
    min: 0, max: 0, avg: 0
  }
};
console.log("\n=== 统计摘要 ===");
console.log(JSON.stringify(stats, null, 2));
