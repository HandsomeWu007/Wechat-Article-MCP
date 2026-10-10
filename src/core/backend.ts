import type { HttpClient } from './http.js';
import { WechatError } from './errors.js';

/**
 * 公众号后台（mp.weixin.qq.com/cgi-bin）能力。
 * 仅在配置了 backend.token + backend.cookie 时可用，用于拉取任意公众号的历史文章列表。
 * 注意：这属于后台管理接口，请只在你自己已登录的账号下使用。
 */

const MP = 'https://mp.weixin.qq.com';

export interface BackendAccount {
  fakeid: string;
  nickname: string;
  alias?: string;
  signature?: string;
  avatar?: string;
}

export interface BackendArticleMeta {
  aid: string;
  title: string;
  link: string;
  digest?: string;
  cover?: string;
  updateTime?: string;
}

function assertCookieToken(cookie: string | undefined, token: string | undefined) {
  if (!cookie || !token) {
    throw new WechatError(
      'NOT_CONFIGURED',
      '公众号后台能力需要凭据：请在 config.json 的 backend 里配置 token 与 cookie（浏览器登录公众号后台后从请求里复制），或设置环境变量 WECHAT_MP_BACKEND_TOKEN / WECHAT_MP_BACKEND_COOKIE',
    );
  }
}

export class BackendClient {
  constructor(
    private readonly http: HttpClient,
    private readonly cookie: string | undefined,
    private readonly token: string | undefined,
  ) {}

  get available(): boolean {
    return Boolean(this.cookie && this.token);
  }

  private referer(): string {
    return `${MP}/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=10&token=${this.token}&lang=zh_CN`;
  }

  private async jsonGet<T>(url: string): Promise<T> {
    assertCookieToken(this.cookie, this.token);
    const res = await this.http.get(url, {
      cookieFrom: 'none',
      headers: {
        Cookie: this.cookie as string,
        Referer: this.referer(),
        'X-Requested-With': 'XMLHttpRequest',
        Accept: 'application/json, text/plain, */*',
      },
    });
    let data: any;
    try {
      data = JSON.parse(res.text);
    } catch {
      throw new WechatError('PARSE_FAILED', '后台接口返回的不是 JSON，凭据可能已失效', {
        snippet: res.text.slice(0, 200),
      });
    }
    const ret = data?.base_resp?.ret;
    if (ret !== undefined && ret !== 0) {
      if (ret === 200013) {
        await this.http.gate.pause(url); throw new WechatError('RATE_LIMITED', '后台接口要求降低频率，已停止');
      }
      if (ret === 200003 || ret === 200040) {
        throw new WechatError('NOT_CONFIGURED', `后台凭据失效或需要重新登录（ret=${ret}），请更新 backend.cookie/token`);
      }
      throw new WechatError('HTTP_ERROR', `后台接口返回错误 ret=${ret}: ${data?.base_resp?.err_msg ?? ''}`);
    }
    return data as T;
  }

  /** 按名称搜索公众号，拿到 fakeid */
  async searchAccount(name: string): Promise<BackendAccount[]> {
    const url =
      `${MP}/cgi-bin/searchbiz?action=search_biz&begin=0&count=10` +
      `&query=${encodeURIComponent(name)}&token=${this.token}&lang=zh_CN&f=json&ajax=1`;
    const data = await this.jsonGet<any>(url);
    const list = (data?.list ?? []).map((it: any) => ({
      fakeid: String(it.fakeid ?? ''),
      nickname: String(it.nickname ?? ''),
      alias: it.alias || undefined,
      signature: it.signature || undefined,
      avatar: it.round_head_img || undefined,
    }));
    return list.filter((a: BackendAccount) => a.fakeid);
  }

  /** 列出某公众号的历史文章（分页） */
  async listArticles(fakeid: string, begin = 0, count = 10): Promise<{ total: number; items: BackendArticleMeta[] }> {
    const url =
      `${MP}/cgi-bin/appmsg?action=list_ex&begin=${begin}&count=${Math.min(count, 20)}` +
      `&fakeid=${encodeURIComponent(fakeid)}&type=9&query=&token=${this.token}&lang=zh_CN&f=json&ajax=1`;
    const data = await this.jsonGet<any>(url);
    const items: BackendArticleMeta[] = (data?.app_msg_list ?? []).map((it: any) => ({
      aid: String(it.aid ?? ''),
      title: String(it.title ?? ''),
      link: String(it.link ?? ''),
      digest: it.digest || undefined,
      cover: it.cover || undefined,
      updateTime: it.update_time ? new Date(Number(it.update_time) * 1000).toISOString() : undefined,
    }));
    return { total: Number(data?.app_msg_cnt ?? items.length), items };
  }
}
