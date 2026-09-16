import { IsIn, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/**
 * What an export request may contain.
 *
 * Plan reference: V2 sections 6.8, 14.5.
 *
 * `filters` is deliberately an open object: a register's filters are its own
 * business and the source validates them. What is *not* open is the sort,
 * which names a column and is checked against the source's allowlist before
 * it reaches SQL, and the format, which is one of two literals.
 */
export class CreateExportDto {
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Z0-9_]+$/, {
    message: 'A grid key is upper-case letters, digits and underscores',
  })
  gridKey!: string;

  @IsIn(['CSV', 'XLSX'], { message: 'Exports are produced as CSV or XLSX' })
  format!: 'CSV' | 'XLSX';

  @IsOptional()
  @IsObject()
  filters?: Record<string, string | number>;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  sort?: string;
}
