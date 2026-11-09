import { Body, Controller, Get, HttpCode, Param, Post, Query, Sse } from "@nestjs/common";
import type { Observable } from "rxjs";
import { map } from "rxjs";
import { AnyAuthenticated, Ctx, id, parse } from "../../common/http";
import type { RequestContext } from "../../common/request-context";
import { listNotificationsSchema, NotificationsService } from "./notifications.service";

/**
 * Notifications for the signed-in person (docs/notifications.md). Every route is the caller's own: there is no way to ask for another person's.
 * What each person is notified about follows the permissions they hold; reading your own needs no extra permission.
 */
@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @AnyAuthenticated()
  @Get()
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const r = await this.notifications.list(ctx, parse(listNotificationsSchema, query));
    return { data: r.items, meta: { total: r.total, unread: r.unread } };
  }

  @AnyAuthenticated()
  @Get("unread-count")
  async unread(@Ctx() ctx: RequestContext) { return { data: { unread: await this.notifications.unreadCount(ctx) } }; }

  @AnyAuthenticated()
  @Post("read-all")
  @HttpCode(200)
  async readAll(@Ctx() ctx: RequestContext, @Body() _body: unknown) { return { data: await this.notifications.markAllRead(ctx) }; }

  @AnyAuthenticated()
  @Post(":id/read")
  @HttpCode(200)
  async read(@Ctx() ctx: RequestContext, @Param("id") notificationId: string) { return { data: await this.notifications.markRead(ctx, id(notificationId)) }; }

  /** Server-sent events: tells an open browser that the unread count or the newest notification changed. */
  @AnyAuthenticated()
  @Sse("stream")
  stream(@Ctx() ctx: RequestContext): Observable<{ type: string; data: object }> {
    return this.notifications.stream(ctx).pipe(map((e) => ({ type: e.type, data: e.data })));
  }
}
