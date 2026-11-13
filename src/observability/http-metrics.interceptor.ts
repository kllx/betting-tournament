import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { finalize, Observable } from "rxjs";
import { MetricsService } from "./metrics.service";

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();
    const started = performance.now();
    const route = request.route?.path ?? "unmatched";
    return next.handle().pipe(
      finalize(() => {
        this.metrics.httpHandled(
          request.method,
          route,
          response.statusCode,
          performance.now() - started,
        );
      }),
    );
  }
}
