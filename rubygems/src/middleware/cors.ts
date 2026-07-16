import { NextFunction, Request, Response } from 'express';

export function createCorsMiddleware() {
    return (req: Request, res: Response, next: NextFunction): void => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Accept, Authorization, Content-Type, X-Base-Url');
        res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Link');

        if (req.method === 'OPTIONS') {
            res.status(204).end();
            return;
        }

        next();
    };
}
