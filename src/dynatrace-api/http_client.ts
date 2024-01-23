/**
  Copyright 2022 Dynatrace LLC

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

      https://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
 */

import axios, { ResponseType } from "axios";
import FormData = require("form-data");
import * as logger from "../utils/logging";
import { DynatraceAPIError } from "./errors";
import { DynatraceAxiosError, ErrorEnvelope, PaginatedResponse } from "./interfaces/dynatrace";

/**
 * Implementation of a HTTP Client specialised for accessing Dynatrace APIs
 */
export class HttpClient {
  private readonly logTrace = ["dynatrace-api", "http_client", "HttpClient"];
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(baseUrl: string, apiToken: string) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
  }

  /**
   * Makes an HTTP Request with the given details.
   * All requests automatically contain the API Token as Authorization header
   * @param path URL path for the web request endpoint
   * @param params query parameters; in case of POST or PUT it becomes body of request
   * @param method HTTP method to use
   * @param headers additional request headers
   * @param queryParams query parameters; to be used for POST and PUT requests
   * @returns response data
   */
  async makeRequest<T = never>(
    path: string,
    params?: Record<string, unknown>,
    method: string = "GET",
    headers: Record<string, string> = {},
    queryParams?: Record<string, unknown>,
    files?: { file: Buffer; name: string },
    responseType?: ResponseType,
  ): Promise<T> {
    const fnLogTrace = [...this.logTrace, "makeRequest"];
    const url = `${this.baseUrl}${path}`;

    let body = null;
    if (method === "POST" || method === "PUT") {
      body = params;
      params = queryParams;
    }

    if (!("Content-Type" in headers)) {
      headers["Content-type"] = "application/json";
    }
    const form = new FormData();
    if (files) {
      headers["Content-type"] = "multipart/form-data";
      form.append("file", files.file, files.name);
    }
    headers.Authorization = `Api-Token ${this.apiToken}`;

    logger.debug(
      `Making ${method} request to ${url} ${
        params ? "with params " + JSON.stringify(params) : ""
      } ${body ? " and body " + JSON.stringify(body) : ""}`,
      ...fnLogTrace,
    );

    return axios
      .request({
        url: url,
        headers: headers,
        params: params,
        method: method,
        data: files ? form : body,
        responseType,
      })
      .then(res => {
        if (res.status >= 400) {
          const errorData = res.data as ErrorEnvelope;
          const message = `Error making request to ${url}: ${
            res.status
          }. Response: ${JSON.stringify(errorData, undefined, 2)}`;
          logger.error(errorData, ...fnLogTrace);
          throw new DynatraceAPIError(message, errorData.error);
        }
        return res.data as T;
      })
      .catch((err: unknown) => {
        if (Object.keys(err ?? {}).includes("response")) {
          // Request was made, server responded with non-2xx, axios threw as error
          throw new DynatraceAPIError(
            (err as DynatraceAxiosError).message,
            (err as DynatraceAxiosError).response.data.error,
          );
        } else if (Object.keys(err ?? {}).includes("request")) {
          // Request was made, but no response received
          logger.error(err, ...fnLogTrace);
          throw new DynatraceAPIError(`No response from server ${this.baseUrl}`, {
            code: 0,
            constraintViolations: [],
            message: (err as Error).message,
          });
        } else {
          // Something else unexpected happened
          const message = `Error making request to ${url}: ${(err as Error).message}.`;
          logger.error(message, ...fnLogTrace);
          throw new DynatraceAPIError(message, {
            code: 0,
            constraintViolations: [],
            message: message,
          });
        }
      });
  }

  /**
   * Makes a paginated GET API call, going over all pages and returning the full list of items.
   * @param path path of the API endpoint
   * @param item the attribute in the response that holds the items
   * @param params query parameters
   * @param headers additional request headers
   * @returns list of items
   */
  async paginatedCall<T = never, R = T[]>(
    path: string,
    item: string,
    params?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<R> {
    const items: T[] = [];
    let nextPageKey: string | undefined = "firstCall";

    while (nextPageKey) {
      if (nextPageKey !== "firstCall") {
        params = { nextPageKey: nextPageKey };
      }

      const response: PaginatedResponse<T> = await this.makeRequest(path, params, "GET", headers);
      nextPageKey = response.nextPageKey;
      if (item in response) {
        items.push(...response[item]);
      }
    }

    return items as R;
  }
}
