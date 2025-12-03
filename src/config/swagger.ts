import swaggerJsdoc from 'swagger-jsdoc';

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MakeAnon API',
      version: '2.0.0',
      description: `
MakeAnon is an email masking service that allows you to create unlimited email aliases to protect your real email address from spam, data breaches, and unwanted tracking.

## Features
- Create unlimited email aliases
- Forward emails to your real address
- Block unwanted senders
- Multiple domain options

## Authentication
Some endpoints require authentication via JWT token. Include the token in the Authorization header:
\`\`\`
Authorization: Bearer <your-token>
\`\`\`

## Public Alias Management
Public aliases can be managed using a management token (sent via email when the alias is created).
      `,
      contact: {
        name: 'MakeAnon Support',
        url: 'https://makeanon.info',
      },
    },
    servers: [
      {
        url: '/api/v1',
        description: 'API v1',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            success: { type: 'boolean', example: false },
            error: { type: 'string', example: 'Error message' },
          },
        },
        Alias: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            alias: { type: 'string', example: 'abc123' },
            fullAddress: { type: 'string', example: 'abc123@makeanon.info' },
            destinationEmail: { type: 'string', example: 'user@example.com' },
            label: { type: 'string', nullable: true },
            description: { type: 'string', nullable: true },
            isActive: { type: 'boolean' },
            emailVerified: { type: 'boolean' },
            replyEnabled: { type: 'boolean' },
            forwardCount: { type: 'integer' },
            blockedCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        Domain: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            domain: { type: 'string', example: 'makeanon.info' },
            isActive: { type: 'boolean' },
            isPublic: { type: 'boolean' },
          },
        },
      },
    },
    tags: [
      { name: 'Health', description: 'Health check endpoints' },
      { name: 'Public', description: 'Public endpoints (no auth required)' },
      { name: 'Aliases', description: 'Alias management (requires auth)' },
      { name: 'Auth', description: 'Authentication endpoints' },
      { name: 'Domains', description: 'Domain management' },
    ],
  },
  apis: ['./src/routes/*.ts', './src/config/swagger-paths.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
