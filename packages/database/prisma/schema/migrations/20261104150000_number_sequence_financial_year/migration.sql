-- Numbers can restart every Indian financial year (1 April), the way GST bill series are kept. The pattern then uses {FY}, e.g. INV/{FY}/{SEQ}.

-- AlterEnum
ALTER TYPE "ResetPolicy" ADD VALUE 'FINANCIAL_YEAR';
