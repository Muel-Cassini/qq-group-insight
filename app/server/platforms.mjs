// 平台常量：中文名、登录页地址、域名（用于「采集结束后关掉社媒标签页」时精确匹配）
//
// 登录页地址都选「未登录时会自然跳到登录界面」的那个页面：
//   - 小红书：/user/profile/me 在未登录时会被重定向到登录页（check_login.py 也用这个判据）
//   - 知乎：/signin 是登录页
//   - B站：passport.bilibili.com/login 是登录页
// 这样同一个按钮在「已登录」时也不会打开一个空白页。

export const PLATFORMS = {
  xhs: {
    code: 'xhs',
    name: '小红书',
    loginUrl: 'https://www.xiaohongshu.com/user/profile/me',
    homeUrl: 'https://www.xiaohongshu.com/explore',
    hosts: ['xiaohongshu.com'],
  },
  zhihu: {
    code: 'zhihu',
    name: '知乎',
    loginUrl: 'https://www.zhihu.com/signin',
    homeUrl: 'https://www.zhihu.com/',
    hosts: ['zhihu.com'],
  },
  bili: {
    code: 'bili',
    name: 'B站',
    loginUrl: 'https://passport.bilibili.com/login',
    homeUrl: 'https://www.bilibili.com/',
    hosts: ['bilibili.com'],
  },
  douyin: { code: 'douyin', name: '抖音', loginUrl: 'https://www.douyin.com/', homeUrl: 'https://www.douyin.com/', hosts: ['douyin.com'] },
  kuaishou: { code: 'kuaishou', name: '快手', loginUrl: 'https://www.kuaishou.com/', homeUrl: 'https://www.kuaishou.com/', hosts: ['kuaishou.com'] },
  weibo: { code: 'weibo', name: '微博', loginUrl: 'https://weibo.com/login.php', homeUrl: 'https://weibo.com/', hosts: ['weibo.com', 'weibo.cn'] },
  tieba: { code: 'tieba', name: '贴吧', loginUrl: 'https://tieba.baidu.com/', homeUrl: 'https://tieba.baidu.com/', hosts: ['tieba.baidu.com'] },
};

export const DEFAULT_LOGIN_PLATFORMS = ['xhs', 'zhihu', 'bili'];

export function platformMeta(code) {
  return PLATFORMS[code] || { code, name: code, loginUrl: '', homeUrl: '', hosts: [] };
}

export function platformName(code) {
  return platformMeta(code).name;
}

/** 判断一个标签页 URL 是否属于某平台（用于只关「采集刚打开的」社媒标签页） */
export function urlMatchesPlatform(url, code) {
  const hosts = platformMeta(code).hosts;
  if (!hosts.length) return false;
  const text = String(url || '').toLowerCase();
  return hosts.some((host) => text.includes(host));
}
