/**
 * Legacy development entrypoint.
 *
 * The application now uses MySQL, so an in-memory PostgreSQL bootstrap would
 * test a different database dialect. Configure MYSQL_URL and run this file
 * only when a real MySQL-compatible database is available.
 */
import './index';
