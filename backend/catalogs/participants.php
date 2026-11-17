<?php
// GET: la app consulta este catálogo con parámetros en la URL (antes era POST y respondía 405).
$method='GET'; $module='catalogs'; $action='participants';
require __DIR__.'/../workflow.php';
