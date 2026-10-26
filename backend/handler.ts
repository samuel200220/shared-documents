import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { apiHandler } from "./src/api.js";

export const handler: APIGatewayProxyHandlerV2 = async (event) => apiHandler(event);
