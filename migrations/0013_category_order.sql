-- Ordem das categorias na vitrine (lista JSON de nomes). Categorias fora da
-- lista aparecem depois, em ordem alfabética.
ALTER TABLE stores ADD COLUMN category_order TEXT NOT NULL DEFAULT '[]';
