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

## Alias Management
Aliases are managed using a management token provided when the alias is created. Save this token - it cannot be recovered.
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
      { name: 'Health', description: 'Health check and statistics' },
      { name: 'Aliases', description: 'Create and manage email aliases' },
      { name: 'Domains', description: 'Available email domains' },
    ],
  },
  apis: ['./src/routes/*.ts', './src/config/swagger-paths.ts'],
};

export const swaggerSpec = swaggerJsdoc(options);
