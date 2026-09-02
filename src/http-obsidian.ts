import { requestUrl } from "obsidian";
import type { HttpPort } from "./api";

export const obsidianHttp: HttpPort = {
  async request(req) {
    const res = await requestUrl({
      url: req.url,
      method: req.method,
      headers: req.headers,
      body: req.body,
      throw: false,
    });
    return { status: res.status, text: res.text };
  },
};
