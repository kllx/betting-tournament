import { of } from "rxjs";
import { HttpMetricsInterceptor } from "./http-metrics.interceptor";

describe("HttpMetricsInterceptor", () => {
  it("uses the route template instead of the query string as a label", async () => {
    const httpHandled = jest.fn();
    const interceptor = new HttpMetricsInterceptor({ httpHandled } as any);
    const request = {
      route: { path: "/metrics" },
      url: "/metrics?token=unique-1",
      method: "GET",
    };
    const response = { statusCode: 200 };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    };

    await interceptor
      .intercept(context as any, { handle: () => of({}) })
      .toPromise();

    expect(httpHandled).toHaveBeenCalledWith(
      "GET",
      "/metrics",
      200,
      expect.any(Number),
    );
  });
});
