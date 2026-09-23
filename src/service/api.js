import Meting from '@meting/core'
import aesjs from 'aes-js'
import hashjs from 'hash.js'
import { HTTPException } from 'hono/http-exception'

const METING_METHODS = new Set([
  'search',
  'song',
  'album',
  'artist',
  'playlist',
  'lrc',
  'url',
  'pic'
])

const QQ_HEADERS = {
  'Content-Type': 'application/json',
  'Referer': 'https://y.qq.com/',
  'Origin': 'https://y.qq.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'
}

/* =========================================================
 * QQ Cookie
 * ========================================================= */

const parseTencentCookie = (cookie = '') => {
  const result = {}

  String(cookie)
    .split(';')
    .forEach(item => {
      const index = item.indexOf('=')

      if (index <= 0) {
        return
      }

      const key =
        item.slice(0, index).trim()

      const value =
        item.slice(index + 1).trim()

      if (key) {
        result[key] = value
      }
    })

  return result
}

/* =========================================================
 * QQ 认证信息
 * ========================================================= */

const getTencentAuth = (cookie = '') => {
  const cookies =
    parseTencentCookie(cookie)

  const uin =
    cookies.uin ||
    cookies.wxuin ||
    cookies.qlogin_uid ||
    cookies.qqmusic_uin ||
    '0'

  const authst =
    cookies.authst ||
    cookies.strAuthst ||
    cookies.str_authst ||
    cookies.psrf_authst ||
    ''

  const qqmusicKey =
    cookies.qqmusic_key || ''

  const qmKeyst =
    cookies.qm_keyst || ''

  const loginType =
    cookies.login_type ||
    cookies.loginType ||
    cookies.tmeLoginType ||
    '1'

  return {
    uin:
      String(uin),

    authst:
      String(authst),

    qqmusicKey:
      String(qqmusicKey),

    qmKeyst:
      String(qmKeyst),

    hasRealAuthst:
      Boolean(authst),

    hasQqmusicKey:
      Boolean(qqmusicKey),

    hasQmKeyst:
      Boolean(qmKeyst),

    loginType:
      String(loginType)
  }
}

/* =========================================================
 * QQ 请求 Header
 *
 * 关键修复：
 * 把实际 Cookie 发给 QQ 上游
 * ========================================================= */

const getQQHeaders = cookie => {
  const headers = {
    ...QQ_HEADERS
  }

  if (cookie) {
    headers.Cookie = cookie
  }

  return headers
}

/* =========================================================
 * 获取 QQ Cookie
 * ========================================================= */

const getTencentCookie = async env => {
  let cookie = ''

  try {
    const cookieModule =
      await import('../utils/cookie.js')

    if (
      typeof cookieModule.readCookieAsync ===
      'function'
    ) {
      cookie =
        await cookieModule.readCookieAsync(
          'tencent',
          env
        )
    }
  } catch {}

  if (
    !cookie &&
    env?.METING_COOKIE_TENCENT
  ) {
    cookie =
      env.METING_COOKIE_TENCENT
  }

  return cookie || ''
}

/* =========================================================
 * QQ zzc 签名
 * ========================================================= */

const tencentZzcSign = payload => {
  const hash =
    hashjs
      .sha1()
      .update(payload)
      .digest('hex')
      .toUpperCase()

  const part1Indexes = [
    23,
    14,
    6,
    36,
    16,
    40,
    7,
    19
  ]

  const part2Indexes = [
    16,
    1,
    32,
    12,
    19,
    27,
    8,
    5
  ]

  const scramble = [
    89,
    39,
    179,
    150,
    218,
    82,
    58,
    252,
    177,
    52,
    186,
    123,
    120,
    64,
    242,
    133,
    143,
    161,
    121,
    179
  ]

  const part1 =
    part1Indexes
      .map(i => hash[i] || '')
      .join('')

  const part2 =
    part2Indexes
      .map(i => hash[i] || '')
      .join('')

  let encoded = ''

  for (
    let i = 0;
    i < scramble.length;
    i++
  ) {
    const value =
      scramble[i] % hash.length

    encoded +=
      hash[value] || ''
  }

  return (
    `zzc${part1}${encoded}${part2}`
      .toLowerCase()
  )
}

/* =========================================================
 * QQ 搜索
 * ========================================================= */

const tencentSearch = async keyword => {
  const url =
    'https://u.y.qq.com/cgi-bin/musicu.fcg'

  const payload = {
    req_1: {
      method:
        'DoSearchForQQMusicDesktop',

      module:
        'music.search.SearchCgiService',

      param: {
        num_per_page:
          30,

        page_num:
          1,

        query:
          keyword,

        search_type:
          0
      }
    }
  }

  const response =
    await fetch(
      url,
      {
        method:
          'POST',

        headers:
          QQ_HEADERS,

        body:
          JSON.stringify(
            payload
          )
      }
    )

  if (!response.ok) {
    throw new Error(
      `QQ 搜索失败：HTTP ${response.status}`
    )
  }

  const json =
    await response.json()

  const list =
    json
      ?.req_1
      ?.data
      ?.body
      ?.song
      ?.list ||
    []

  return list.map(song => {
    const singers =
      Array.isArray(
        song.singer
      )
        ? song.singer
        : []

    const artist =
      singers
        .map(
          item =>
            item?.name || ''
        )
        .filter(Boolean)
        .join(' / ')

    const songmid =
      song.mid ||
      String(
        song.id || ''
      )

    const mediaMid =
      song?.file?.media_mid ||
      song?.media_mid ||
      song?.strMediaMid ||
      ''

    const albumMid =
      song?.album?.mid ||
      ''

    return {
      id:
        songmid,

      name:
        song.name || '',

      artist,

      album:
        song?.album?.name || '',

      pic_id:
        albumMid,

      url_id:
        songmid,

      lyric_id:
        songmid,

      media_mid:
        mediaMid,

      song_id:
        song.id || '',

      source:
        'tencent'
    }
  })
}

/* =========================================================
 * QQ 歌曲详情
 * ========================================================= */

const tencentSongDetail = async (
  songmid,
  cookie
) => {
  const auth =
    getTencentAuth(
      cookie
    )

  const payload = {
    comm: {
      ct:
        24,

      cv:
        4747474,

      format:
        'json',

      inCharset:
        'utf-8',

      outCharset:
        'utf-8',

      notice:
        0,

      platform:
        'yqq.json',

      needNewCode:
        1,

      uin:
        auth.uin
    },

    songinfo: {
      method:
        'get_song_detail_yqq',

      module:
        'music.pf_song_detail_svr',

      param: {
        song_mid:
          songmid,

        song_id:
          0
      }
    }
  }

  const response =
    await fetch(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      {
        method:
          'POST',

        headers:
          getQQHeaders(
            cookie
          ),

        body:
          JSON.stringify(
            payload
          )
      }
    )

  if (!response.ok) {
    throw new Error(
      `QQ 歌曲详情请求失败：HTTP ${response.status}`
    )
  }

  const json =
    await response.json()

  const track =
    json
      ?.songinfo
      ?.data
      ?.track_info

  if (!track) {
    throw new Error(
      'QQ 歌曲详情没有 track_info'
    )
  }

  const mediaMid =
    track?.file?.media_mid ||
    track?.media_mid ||
    track?.strMediaMid ||
    ''

  if (!mediaMid) {
    throw new Error(
      'QQ 歌曲详情没有 media_mid'
    )
  }

  return {
    songmid,

    media_mid:
      mediaMid,

    song_id:
      track.id || '',

    name:
      track.name || '',

    title:
      track.title || '',

    singer:
      Array.isArray(
        track.singer
      )
        ? track.singer
            .map(
              x =>
                x.name
            )
            .join(' / ')
        : '',

    album:
      track?.album?.name || ''
  }
}

/* =========================================================
 * QQ 音质配置
 * ========================================================= */

const QQ_QUALITY_MAP = {
  M800: {
    prefix:
      'M800',

    ext:
      '.mp3'
  },

  M500: {
    prefix:
      'M500',

    ext:
      '.mp3'
  },

  C400: {
    prefix:
      'C400',

    ext:
      '.m4a'
  },

  F000: {
    prefix:
      'F000',

    ext:
      '.flac'
  },

  RS01: {
    prefix:
      'RS01',

    ext:
      '.flac'
  }
}

/* =========================================================
 * 从 QQ 响应中提取播放信息
 *
 * 兼容：
 *
 * 1. req_0
 * 2. req_1
 * 3. music.vkey.GetVkeyServer.CgiGetVkey
 * 4. music.vkey.GetEVkey.CgiGetEVkey
 * ========================================================= */

const extractQQPlayData = (
  json,
  method
) => {
  const possibleKeys =
    method === 'CgiGetEVkey'
      ? [
          'req_1',
          'music.vkey.GetEVkey.CgiGetEVkey'
        ]
      : [
          'req_0',
          'music.vkey.GetVkeyServer.CgiGetVkey'
        ]

  let req = null

  for (
    const key of possibleKeys
  ) {
    if (
      json?.[key]
    ) {
      req =
        json[key]

      break
    }
  }

  if (!req) {
    return {
      req:
        null,

      data:
        {},

      list:
        [],

      sip:
        [],

      result:
        json?.code ?? '',

      subcode:
        ''
    }
  }

  const data =
    req?.data ||
    {}

  const list =
    Array.isArray(
      data?.midurlinfo
    )
      ? data.midurlinfo
      : []

  const sip =
    Array.isArray(
      data?.sip
    )
      ? data.sip
      : []

  const result =
    data?.result ??
    req?.code ??
    json?.code ??
    ''

  const subcode =
    data?.subcode ??
    req?.subcode ??
    ''

  return {
    req,
    data,
    list,
    sip,
    result,
    subcode
  }
}

/* =========================================================
 * QQ 播放 URL 拼接
 * ========================================================= */

const buildQQPlayUrl = (
  purl,
  sip
) => {
  if (!purl) {
    return ''
  }

  if (
    purl.startsWith(
      'http://'
    ) ||
    purl.startsWith(
      'https://'
    )
  ) {
    return purl
  }

  const domain =
    sip.find(
      item =>
        typeof item === 'string' &&
        (
          item.startsWith(
            'http://'
          ) ||
          item.startsWith(
            'https://'
          )
        )
    ) ||
    'https://isure.stream.qqmusic.qq.com/'

  return (
    domain.replace(
      /\/$/,
      ''
    ) +
    '/' +
    purl.replace(
      /^\//,
      ''
    )
  )
}

/* =========================================================
 * QQ CgiGetVkey
 * ========================================================= */

const tencentVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie
) => {
  const auth =
    getTencentAuth(
      cookie
    )

  const current =
    QQ_QUALITY_MAP[
      quality
    ] ||
    QQ_QUALITY_MAP.M800

  const filename =
    `${current.prefix}${mediaMid}${current.ext}`

  const guid =
    String(
      Date.now() +
      Math.floor(
        Math.random() *
        100000000
      )
    )

  const uin =
    auth.uin ||
    '0'

  const payload = {
    req_0: {
      module:
        'vkey.GetVkeyServer',

      method:
        'CgiGetVkey',

      param: {
        filename: [
          filename
        ],

        guid,

        songmid: [
          songmid
        ],

        songtype: [
          0
        ],

        uin,

        loginflag:
          1,

        platform:
          '20'
      }
    },

    comm: {
      uin:
        Number(uin) || 0,

      format:
        'json',

      ct:
        24,

      cv:
        4747474,

      inCharset:
        'utf-8',

      outCharset:
        'utf-8',

      notice:
        0,

      platform:
        'yqq.json',

      needNewCode:
        1
    }
  }

  /*
   * 只有真正的 authst
   * 才放进 comm.authst。
   *
   * 不再把 qqmusic_key /
   * qm_keyst 冒充 authst。
   */
  if (
    auth.authst
  ) {
    payload.comm.authst =
      auth.authst
  }

  const body =
    JSON.stringify(
      payload
    )

  const sign =
    tencentZzcSign(
      body
    )

  const requestUrl =
    `https://u.y.qq.com/cgi-bin/musics.fcg?_=${Date.now()}&sign=${encodeURIComponent(sign)}`

  const response =
    await fetch(
      requestUrl,
      {
        method:
          'POST',

        headers:
          getQQHeaders(
            cookie
          ),

        body
      }
    )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `QQ VKEY ${quality} HTTP ${response.status}: ${responseText.slice(0, 2000)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(
        responseText
      )
  } catch {
    throw new Error(
      `QQ VKEY ${quality} 返回非 JSON：${responseText.slice(0, 2000)}`
    )
  }

  const parsed =
    extractQQPlayData(
      json,
      'CgiGetVkey'
    )

  const item =
    parsed.list.find(
      item =>
        item?.purl ||
        item?.wifiurl
    ) ||
    null

  const purl =
    item?.purl ||
    item?.wifiurl ||
    ''

  if (!purl) {
    throw new Error(
      JSON.stringify({
        method:
          'CgiGetVkey',

        quality,

        filename,

        guid,

        uin,

        qq_code:
          json?.code ??
          '',

        req_code:
          parsed.req?.code ??
          '',

        result:
          parsed.result,

        subcode:
          parsed.subcode,

        sip:
          parsed.sip,

        midurlinfo:
          parsed.list,

        response_keys:
          Object.keys(
            json || {}
          )
      })
    )
  }

  return buildQQPlayUrl(
    purl,
    parsed.sip
  )
}

/* =========================================================
 * QQ CgiGetEVkey
 *
 * 修复：
 * 1. Cookie 真正发送
 * 2. authst 变量作用域
 * 3. 兼容真实返回键
 * ========================================================= */

const tencentEVkey = async (
  songmid,
  mediaMid,
  quality,
  cookie
) => {
  const auth =
    getTencentAuth(
      cookie
    )

  const current =
    QQ_QUALITY_MAP[
      quality
    ] ||
    QQ_QUALITY_MAP.M800

  const filename =
    `${current.prefix}${mediaMid}${current.ext}`

  const guid =
    String(
      Date.now() +
      Math.floor(
        Math.random() *
        100000000
      )
    )

  const uin =
    auth.uin ||
    '0'

  const common = {
    cv:
      13020508,

    v:
      13020508,

    ct:
      '19',

    tmeAppID:
      'qqmusic',

    format:
      'json',

    inCharset:
      'utf-8',

    outCharset:
      'utf-8',

    uid:
      uin,

    uin:
      uin,

    QIMEI36:
      '0000000000000000000000000000000000000000000000'
  }

  if (
    auth.authst
  ) {
    common.authst =
      auth.authst
  }

  if (
    uin !== '0'
  ) {
    common.qq =
      uin

    common.tmeLoginType =
      auth.loginType
  }

  const payload = {
    comm:
      common,

    req_1: {
      method:
        'CgiGetEVkey',

      module:
        'music.vkey.GetEVkey',

      param: {
        filename: [
          filename
        ],

        guid,

        songmid: [
          songmid
        ],

        songtype: [
          0
        ],

        uin,

        loginflag:
          1,

        platform:
          '20',

        ctx:
          1
      }
    }
  }

  const body =
    JSON.stringify(
      payload
    )

  const sign =
    tencentZzcSign(
      body
    )

  const requestUrl =
    `https://u.y.qq.com/cgi-bin/musics.fcg?sign=${encodeURIComponent(sign)}`

  const response =
    await fetch(
      requestUrl,
      {
        method:
          'POST',

        headers:
          getQQHeaders(
            cookie
          ),

        body
      }
    )

  const responseText =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `QQ EVKEY ${quality} HTTP ${response.status}: ${responseText.slice(0, 2000)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(
        responseText
      )
  } catch {
    throw new Error(
      `QQ EVKEY ${quality} 返回非 JSON：${responseText.slice(0, 2000)}`
    )
  }

  const parsed =
    extractQQPlayData(
      json,
      'CgiGetEVkey'
    )

  const item =
    parsed.list.find(
      item =>
        item?.purl ||
        item?.wifiurl
    ) ||
    null

  const purl =
    item?.purl ||
    item?.wifiurl ||
    ''

  if (!purl) {
    throw new Error(
      JSON.stringify({
        method:
          'CgiGetEVkey',

        quality,

        filename,

        guid,

        uin,

        qq_code:
          json?.code ??
          '',

        req_code:
          parsed.req?.code ??
          '',

        result:
          parsed.result,

        subcode:
          parsed.subcode,

        sip:
          parsed.sip,

        midurlinfo:
          parsed.list,

        response_keys:
          Object.keys(
            json || {}
          )
      })
    )
  }

  return buildQQPlayUrl(
    purl,
    parsed.sip
  )
}

/* =========================================================
 * QQ 旧版 MusicExpress
 *
 * 备用：
 *
 * fcg_music_express_mobile3.fcg
 *
 * 通过 songmid + filename + guid
 * 获取 vkey
 * ========================================================= */

const tencentMusicExpress = async (
  songmid,
  quality,
  cookie
) => {
  const current =
    QQ_QUALITY_MAP[
      quality
    ] ||
    QQ_QUALITY_MAP.C400

  const guid =
    String(
      Date.now() +
      Math.floor(
        Math.random() *
        100000000
      )
    )

  const filename =
    `${current.prefix}${songmid}${current.ext}`

  const params =
    new URLSearchParams()

  params.set(
    'g_tk',
    '5381'
  )

  params.set(
    'loginUin',
    '0'
  )

  params.set(
    'hostUin',
    '0'
  )

  params.set(
    'format',
    'json'
  )

  params.set(
    'inCharset',
    'utf8'
  )

  params.set(
    'outCharset',
    'utf-8'
  )

  params.set(
    'notice',
    '0'
  )

  params.set(
    'platform',
    'yqq'
  )

  params.set(
    'needNewCode',
    '0'
  )

  params.set(
    'cid',
    '205361747'
  )

  params.set(
    'uin',
    '0'
  )

  params.set(
    'songmid',
    songmid
  )

  params.set(
    'filename',
    filename
  )

  params.set(
    'guid',
    guid
  )

  const requestUrl =
    `https://c.y.qq.com/base/fcgi-bin/fcg_music_express_mobile3.fcg?${params.toString()}`

  const response =
    await fetch(
      requestUrl,
      {
        method:
          'GET',

        headers:
          getQQHeaders(
            cookie
          )
      }
    )

  const text =
    await response.text()

  if (!response.ok) {
    throw new Error(
      `QQ MusicExpress ${quality} HTTP ${response.status}: ${text.slice(0, 1000)}`
    )
  }

  let json

  try {
    json =
      JSON.parse(
        text
      )
  } catch {
    throw new Error(
      `QQ MusicExpress ${quality} 返回非 JSON：${text.slice(0, 1000)}`
    )
  }

  const items =
    Array.isArray(
      json?.data?.items
    )
      ? json.data.items
      : []

  const item =
    items.find(
      x =>
        x?.vkey
    ) ||
    null

  const vkey =
    item?.vkey ||
    ''

  if (!vkey) {
    throw new Error(
      JSON.stringify({
        method:
          'MusicExpress',

        quality,

        filename,

        guid,

        code:
          json?.code ??
          '',

        data:
          json?.data ||
          {},

        response_keys:
          Object.keys(
            json || {}
          )
      })
    )
  }

  const domain =
    'https://isure.stream.qqmusic.qq.com/'

  return (
    `${domain}${filename}` +
    `?vkey=${encodeURIComponent(vkey)}` +
    `&guid=${encodeURIComponent(guid)}` +
    `&uin=0` +
    `&fromtag=66`
  )
}

/* =========================================================
 * QQ 状态
 * ========================================================= */

const tencentStatus = async env => {
  const cookie =
    await getTencentCookie(
      env
    )

  if (!cookie) {
    return {
      ok:
        false,

      cookie_configured:
        false,

      uin:
        false,

      wxuin:
        false,

      qm_keyst:
        false,

      qqmusic_key:
        false,

      authst:
        false,

      authst_source:
        'none',

      access_token:
        false,

      refresh_token:
        false,

      playback_key:
        false,

      message:
        '未读取到 METING_COOKIE_TENCENT'
    }
  }

  const cookies =
    parseTencentCookie(
      cookie
    )

  const auth =
    getTencentAuth(
      cookie
    )

  const hasMusicKey =
    Boolean(
      cookies.qm_keyst ||
      cookies.qqmusic_key
    )

  const hasRealAuthst =
    Boolean(
      auth.hasRealAuthst
    )

  let message =
    '已读取 QQ Cookie'

  if (
    hasRealAuthst
  ) {
    message =
      '已检测到 authst/strAuthst，可继续测试 QQ EVKEY'
  } else if (
    hasMusicKey
  ) {
    message =
      '未检测到独立 authst；当前仅检测到 qqmusic_key/qm_keyst，EVKEY 可能仍受播放授权限制'
  } else {
    message =
      '未检测到 authst、qqmusic_key 或 qm_keyst'
  }

  return {
    ok:
      true,

    cookie_configured:
      true,

    uin:
      Boolean(
        cookies.uin
      ),

    wxuin:
      Boolean(
        cookies.wxuin
      ),

    qm_keyst:
      Boolean(
        cookies.qm_keyst
      ),

    qqmusic_key:
      Boolean(
        cookies.qqmusic_key
      ),

    authst:
      hasRealAuthst,

    authst_source:
      hasRealAuthst
        ? 'authst/strAuthst'
        : hasMusicKey
          ? 'qqmusic_key/qm_keyst'
          : 'none',

    access_token:
      Boolean(
        cookies.access_token ||
        cookies.accessToken
      ),

    refresh_token:
      Boolean(
        cookies.refresh_token ||
        cookies.refreshToken
      ),

    playback_key:
      Boolean(
        cookies.playback_key ||
        cookies.playbackKey ||
        cookies.playback_token ||
        cookies.playbackToken ||
        cookies.strPlaybackKey ||
        cookies.str_playback_key
      ),

    message
  }
}

/* =========================================================
 * QQ EVKEY 测试
 * ========================================================= */

const tencentEVkeyTest = async (
  songmid,
  env
) => {
  const cookie =
    await getTencentCookie(
      env
    )

  if (!cookie) {
    throw new Error(
      '未配置 QQ Cookie'
    )
  }

  const detail =
    await tencentSongDetail(
      songmid,
      cookie
    )

  const qualities = [
    'M800',
    'M500',
    'C400',
    'F000',
    'RS01'
  ]

  const results = []

  for (
    const quality
    of qualities
  ) {
    try {
      const url =
        await tencentEVkey(
          songmid,
          detail.media_mid,
          quality,
          cookie
        )

      results.push({
        quality,

        ok:
          true,

        url
      })

      return {
        ok:
          true,

        songmid,

        media_mid:
          detail.media_mid,

        results
      }
    } catch (error) {
      results.push({
        quality,

        ok:
          false,

        error:
          error?.message ||
          String(error)
      })
    }
  }

  return {
    ok:
      false,

    songmid,

    media_mid:
      detail.media_mid,

    results
  }
}

/* =========================================================
 * QQ 播放地址
 *
 * 第一阶段：
 * CgiGetVkey
 *
 * 第二阶段：
 * CgiGetEVkey
 *
 * 第三阶段：
 * MusicExpress
 * ========================================================= */

const tencentGetUrl = async (
  id,
  env
) => {
  const cookie =
    await getTencentCookie(
      env
    )

  if (!cookie) {
    throw new Error(
      '未配置 QQ Cookie'
    )
  }

  const detail =
    await tencentSongDetail(
      id,
      cookie
    )

  const qualities = [
    'M800',
    'M500',
    'C400',
    'F000',
    'RS01'
  ]

  const diagnostics = []

  /* =======================================================
   * 第一阶段：CgiGetVkey
   * ======================================================= */

  for (
    const quality
    of qualities
  ) {
    try {
      const url =
        await tencentVkey(
          id,
          detail.media_mid,
          quality,
          cookie
        )

      return url
    } catch (error) {
      diagnostics.push({
        method:
          'CgiGetVkey',

        quality,

        error:
          error?.message ||
          String(error)
      })
    }
  }

  /* =======================================================
   * 第二阶段：CgiGetEVkey
   * ======================================================= */

  for (
    const quality
    of qualities
  ) {
    try {
      const url =
        await tencentEVkey(
          id,
          detail.media_mid,
          quality,
          cookie
        )

      return url
    } catch (error) {
      diagnostics.push({
        method:
          'CgiGetEVkey',

        quality,

        error:
          error?.message ||
          String(error)
      })
    }
  }

  /* =======================================================
   * 第三阶段：旧版 MusicExpress
   *
   * 优先 C400，因为兼容性最高
   * ======================================================= */

  const expressQualities = [
    'C400',
    'M500',
    'M800'
  ]

  for (
    const quality
    of expressQualities
  ) {
    try {
      const url =
        await tencentMusicExpress(
          id,
          quality,
          cookie
        )

      return url
    } catch (error) {
      diagnostics.push({
        method:
          'MusicExpress',

        quality,

        error:
          error?.message ||
          String(error)
      })
    }
  }

  const error =
    new Error(
      'QQ 音乐播放地址获取失败'
    )

  error.diagnostics =
    diagnostics

  throw error
}

/* =========================================================
 * QQ 图片
 * ========================================================= */

const getTencentPic = id => {
  return (
    `https://y.qq.com/music/photo_new/T002R800x800M000${id}.jpg`
  )
}

/* =========================================================
 * QQ 歌词
 * ========================================================= */

const getTencentLyric = async (
  id,
  cookie
) => {
  const auth =
    getTencentAuth(
      cookie
    )

  const payload = {
    comm: {
      ct:
        24,

      cv:
        4747474,

      format:
        'json',

      inCharset:
        'utf-8',

      outCharset:
        'utf-8',

      notice:
        0,

      platform:
        'yqq.json',

      needNewCode:
        1,

      uin:
        auth.uin
    },

    lyric: {
      method:
        'GetLyric',

      module:
        'music.musichallSong.PlayLyricInfo',

      param: {
        songMID:
          id,

        songID:
          0
      }
    }
  }

  const response =
    await fetch(
      'https://u.y.qq.com/cgi-bin/musicu.fcg',
      {
        method:
          'POST',

        headers:
          getQQHeaders(
            cookie
          ),

        body:
          JSON.stringify(
            payload
          )
      }
    )

  if (!response.ok) {
    throw new Error(
      `QQ 歌词请求失败：HTTP ${response.status}`
    )
  }

  const json =
    await response.json()

  const lyric =
    json
      ?.lyric
      ?.data
      ?.lyric ||
    ''

  if (!lyric) {
    return ''
  }

  try {
    const bytes =
      Uint8Array.from(
        atob(lyric),
        c =>
          c.charCodeAt(0)
      )

    return aesjs.utils.utf8.fromBytes(
      bytes
    )
  } catch {
    try {
      return decodeURIComponent(
        escape(
          atob(lyric)
        )
      )
    } catch {
      return lyric
    }
  }
}

/* =========================================================
 * Meting
 * ========================================================= */

const createMeting = (
  server,
  env
) => {
  return new Meting(
    server,
    {
      cookie:
        env?.METING_COOKIE_TENCENT ||
        ''
    }
  )
}

/* =========================================================
 * 主 API
 * ========================================================= */

const api = async c => {
  const server =
    c.req.query('server') ||
    'netease'

  const type =
    c.req.query('type') ||
    'search'

  const id =
    c.req.query('id') ||
    ''

  const keyword =
    c.req.query('name') ||
    c.req.query('keyword') ||
    ''

  const env =
    c.env || {}

  /* =======================================================
   * QQ 状态
   * ======================================================= */

  if (
    server === 'tencent' &&
    type === 'qqstatus'
  ) {
    return c.json(
      await tencentStatus(
        env
      )
    )
  }

  /* =======================================================
   * QQ EVKEY 测试
   * ======================================================= */

  if (
    server === 'tencent' &&
    type === 'evkey'
  ) {
    try {
      const result =
        await tencentEVkeyTest(
          id,
          env
        )

      return c.json(
        result
      )
    } catch (error) {
      return c.json(
        {
          ok:
            false,

          error:
            error?.message ||
            String(error)
        },

        400
      )
    }
  }

  /* =======================================================
   * QQ 搜索
   * ======================================================= */

  if (
    server === 'tencent' &&
    type === 'search'
  ) {
    try {
      const list =
        await tencentSearch(
          keyword
        )

      return c.json(
        list
      )
    } catch (error) {
      return c.json(
        {
          code:
            500,

          message:
            error?.message ||
            String(error),

          data:
            []
        },

        500
      )
    }
  }

  /* =======================================================
   * QQ 播放地址
   * ======================================================= */

  if (
    server === 'tencent' &&
    type === 'url'
  ) {
    try {
      const url =
        await tencentGetUrl(
          id,
          env
        )

      return c.json({
        url
      })
    } catch (error) {
      return c.json(
        {
          code:
            500,

          message:
            error?.message ||
            String(error),

          diagnostics:
            error?.diagnostics ||
            [],

          url:
            ''
        },

        500
      )
    }
  }

  /* =======================================================
   * QQ 图片
   * ======================================================= */

  if (
    server === 'tencent' &&
    type === 'pic'
  ) {
    return c.json({
      url:
        getTencentPic(
          id
        )
    })
  }

  /* =======================================================
   * QQ 歌词
   * ======================================================= */

  if (
    server === 'tencent' &&
    type === 'lrc'
  ) {
    try {
      const cookie =
        await getTencentCookie(
          env
        )

      const lyric =
        await getTencentLyric(
          id,
          cookie
        )

      return c.json({
        lyric
      })
    } catch (error) {
      return c.json(
        {
          code:
            500,

          message:
            error?.message ||
            String(error),

          lyric:
            ''
        },

        500
      )
    }
  }

  /* =======================================================
   * Meting 标准接口
   * ======================================================= */

  if (
    !METING_METHODS.has(
      type
    )
  ) {
    throw new HTTPException(
      400,
      {
        message:
          `不支持的 type：${type}`
      }
    )
  }

  try {
    const meting =
      createMeting(
        server,
        env
      )

    let result

    switch (type) {
      case 'search':
        result =
          await meting.search(
            keyword
          )
        break

      case 'song':
        result =
          await meting.song(
            id
          )
        break

      case 'album':
        result =
          await meting.album(
            id
          )
        break

      case 'artist':
        result =
          await meting.artist(
            id
          )
        break

      case 'playlist':
        result =
          await meting.playlist(
            id
          )
        break

      case 'lrc':
        result =
          await meting.lyric(
            id
          )
        break

      case 'url':
        result =
          await meting.url(
            id
          )
        break

      case 'pic':
        result =
          await meting.pic(
            id
          )
        break

      default:
        throw new Error(
          `未知 type：${type}`
        )
    }

    return c.json(
      result
    )
  } catch (error) {
    console.error(
      'Meting API Error:',
      error
    )

    if (
      error instanceof HTTPException
    ) {
      throw error
    }

    return c.json(
      {
        code:
          500,

        message:
          error?.message ||
          String(error)
      },

      500
    )
  }
}

/* =========================================================
 * Export
 * ========================================================= */

export default api

export {
  api,
  tencentSearch,
  tencentStatus,
  tencentEVkeyTest,
  tencentGetUrl
}