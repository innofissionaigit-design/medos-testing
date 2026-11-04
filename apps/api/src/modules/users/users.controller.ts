import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { AnyAuthenticated, Ctx, id, paginate, parse, RateLimit, RequirePermissions } from "../../common/http";
import { PERMISSIONS } from "@medos/shared";
import type { RequestContext } from "../../common/request-context";
import {
  changePasswordSchema, createRoleSchema, createUserSchema, listUsersSchema, resetPasswordSchema,
  setDepartmentsSchema, setFacilitiesSchema, setPermissionsSchema, setRolesSchema, updateUserSchema, UsersService,
} from "./users.service";

@Controller()
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @RequirePermissions("ADMIN_USERS")
  @Get("users")
  async list(@Ctx() ctx: RequestContext, @Query() query: unknown) {
    const q = parse(listUsersSchema, query);
    const { items, total } = await this.users.list(ctx, q);
    return paginate(items, total, q.page, q.pageSize);
  }

  @RequirePermissions("ADMIN_USERS")
  @Post("users")
  async create(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.users.create(ctx, parse(createUserSchema, body)) };
  }

  @AnyAuthenticated()
  @RateLimit({ limit: 10, windowMs: 60_000, by: "session" })
  @Post("users/me/password")
  @HttpCode(204)
  async changeOwnPassword(@Ctx() ctx: RequestContext, @Body() body: unknown): Promise<void> {
    await this.users.changeOwnPassword(ctx, parse(changePasswordSchema, body));
  }

  @RequirePermissions("ADMIN_USERS")
  @Get("users/:id")
  async get(@Ctx() ctx: RequestContext, @Param("id") userId: string) {
    return { data: await this.users.get(ctx, id(userId)) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Patch("users/:id")
  async update(@Ctx() ctx: RequestContext, @Param("id") userId: string, @Body() body: unknown) {
    return { data: await this.users.update(ctx, id(userId), parse(updateUserSchema, body)) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Put("users/:id/roles")
  async setRoles(@Ctx() ctx: RequestContext, @Param("id") userId: string, @Body() body: unknown) {
    return { data: await this.users.setRoles(ctx, id(userId), parse(setRolesSchema, body)) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Put("users/:id/facilities")
  async setFacilities(@Ctx() ctx: RequestContext, @Param("id") userId: string, @Body() body: unknown) {
    return { data: await this.users.setFacilities(ctx, id(userId), parse(setFacilitiesSchema, body)) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Put("users/:id/departments")
  async setDepartments(@Ctx() ctx: RequestContext, @Param("id") userId: string, @Body() body: unknown) {
    return { data: await this.users.setDepartments(ctx, id(userId), parse(setDepartmentsSchema, body)) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Post("users/:id/reset-password")
  @HttpCode(204)
  async resetPassword(@Ctx() ctx: RequestContext, @Param("id") userId: string, @Body() body: unknown): Promise<void> {
    await this.users.resetPassword(ctx, id(userId), parse(resetPasswordSchema, body));
  }

  /** The permission names a role can hold (for the role editor). */
  @RequirePermissions("ADMIN_USERS")
  @Get("permissions")
  permissions() {
    return { data: [...PERMISSIONS] };
  }

  @RequirePermissions("ADMIN_USERS")
  @Get("roles")
  async roles(@Ctx() ctx: RequestContext) {
    return { data: await this.users.listRoles(ctx) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Post("roles")
  async createRole(@Ctx() ctx: RequestContext, @Body() body: unknown) {
    return { data: await this.users.createRole(ctx, parse(createRoleSchema, body)) };
  }

  @RequirePermissions("ADMIN_USERS")
  @Put("roles/:id/permissions")
  async setRolePermissions(@Ctx() ctx: RequestContext, @Param("id") roleId: string, @Body() body: unknown) {
    return { data: await this.users.setRolePermissions(ctx, id(roleId), parse(setPermissionsSchema, body)) };
  }
}
