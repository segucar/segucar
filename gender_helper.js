/**
 * gender_helper.js - Inferencia algorítmica de género por nombre de pila
 * y estadísticas demográficas para SEGUCar.
 * 
 * ⚠️ REGLA METODOLÓGICA FUNDAMENTAL:
 * - Esta inferencia es una estimación orientativa basada en el nombre de pila.
 * - NO constituye dato registral oficial.
 * - ESTRICTAMENTE PROHIBIDO estimar edad a partir de la numeración de DNI
 *   (en Argentina la correlación no es lineal por DNI duplicados, libretas cívicas/enrolamiento,
 *   y procesos de naturalización). La edad permanece en pausa hasta contar con fecha de nacimiento real.
 */

// Diccionarios extensos de nombres comunes en Argentina y el mundo hispanohablante
const MASCULINE_NAMES = new Set([
    'AARON', 'ABEL', 'ABRAHAM', 'ADAN', 'ADOLFO', 'ADRIAN', 'AGUSTIN', 'AITOR', 'ALAN', 'ALBERTO',
    'ALDO', 'ALEJANDRO', 'ALEJO', 'ALEX', 'ALEXANDER', 'ALEXIS', 'ALFONSO', 'ALFREDO', 'ALONSO', 'ALVARO',
    'AMADEO', 'AMERICO', 'AMILCAR', 'ANDRES', 'ANGEL', 'ANIBAL', 'ANSELMO', 'ANTONIO', 'ARIEL', 'ARMANDO',
    'ARNALDO', 'ARTURO', 'AUGUSTO', 'AURELIO', 'AXEL', 'BAUTISTA', 'BENICIO', 'BENJAMIN', 'BERNARDO', 'BLAS',
    'BRAIAN', 'BRANDON', 'BRIAN', 'BRUNO', 'CAMILO', 'CARLOS', 'CASIMIRO', 'CATRIEL', 'CAYETANO', 'CEFERINO',
    'CELSO', 'CESAR', 'CHRISTIAN', 'CIRO', 'CLAUDIO', 'CLEMENTE', 'CRISTIAN', 'CRISTOBAL', 'DAMIAN', 'DANIEL',
    'DANILO', 'DANTE', 'DARIO', 'DAVID', 'DEMIAN', 'DENIS', 'DIEGO', 'DIONISIO', 'DOMINGO', 'EDGAR',
    'EDGARDO', 'EDMUNDO', 'EDUARDO', 'ELIAS', 'ELISEO', 'ELVIO', 'EMANUEL', 'EMILIANO', 'EMILIO', 'ENRIQUE',
    'ENRRIQUE', 'ENZO', 'ERIC', 'ERICK', 'ERNESTO', 'ESTEBAN', 'EUGENIO', 'EUSEBIO', 'EVARISTO', 'EZEQUIEL',
    'EXEQUIEL', 'FABIAN', 'FABRICIO', 'FACUNDO', 'FAUSTINO', 'FAUSTO', 'FEDERICO', 'FELICIANO', 'FELIPE', 'FELIX',
    'FERMIN', 'FERNANDO', 'FIDEL', 'FILIMON', 'FRANCISCO', 'FRANCO', 'GABRIEL', 'GASPAR', 'GASTON', 'GERARDO',
    'GERMAN', 'GERONIMO', 'GIAN', 'GIANFRANCO', 'GINO', 'GIORGIO', 'GONZALO', 'GREGORIO', 'GUIDO', 'GUILLERMO',
    'GUSTAVO', 'HECTOR', 'HERNAN', 'HILARIO', 'HIPOLITO', 'HONORIO', 'HORACIO', 'HUGO', 'HUMBERTO', 'IAN',
    'IGNACIO', 'INDALECIO', 'ISIDRO', 'ISMAEL', 'IVAN', 'JACINTO', 'JACOBO', 'JAIME', 'JANO', 'JARED',
    'JAVIER', 'JEREMIAS', 'JERONIMO', 'JESUS', 'JOAQUIN', 'JOEL', 'JONATAN', 'JONATHAN', 'JORDAN', 'JORGE',
    'JOSE', 'JOSHUA', 'JOSUE', 'JUAN', 'JULIAN', 'JULIO', 'JUSTO', 'KEVIN', 'LAUREANO', 'LAUTARO',
    'LEANDRO', 'LEON', 'LEONARDO', 'LEONEL', 'LEOPOLDO', 'LISANDRO', 'LIONEL', 'LORENZO', 'LUCAS', 'LUCIANO',
    'LUCIO', 'LUDOVICO', 'LUIS', 'MANUEL', 'MANUELO', 'MARCELINO', 'MARCELO', 'MARCIANO', 'MARCIO', 'MARCO',
    'MARCOS', 'MARIANO', 'MARIO', 'MARTIN', 'MATEO', 'MATIAS', 'MAURICIO', 'MAURO', 'MAXI', 'MAXIMILIANO',
    'MAXIMO', 'MICHAEL', 'MIGUEL', 'MILTON', 'MIQUEAS', 'MIRKO', 'MODESTO', 'NAHUEL', 'NAZARENO', 'NEHEMIAS',
    'NEHUEN', 'NELSON', 'NESTOR', 'NICANOR', 'NICOLAS', 'NOE', 'NORBERTO', 'OCTAVIO', 'OMAR', 'ORLANDO',
    'OSCAR', 'OSVALDO', 'OTTO', 'PABLO', 'PATRICIO', 'PAULO', 'PEDRO', 'RAFAEL', 'RAMIRO', 'RAMON',
    'RAUL', 'REINALDO', 'RENATO', 'RENE', 'RICARDO', 'ROBERTO', 'RODOLFO', 'RODRIGO', 'ROGELIO', 'ROLANDO',
    'ROMAN', 'ROMUALDO', 'RONALDO', 'ROQUE', 'ROSENDO', 'RUBEN', 'RUFINO', 'SALVADOR', 'SAMUEL', 'SANTIAGO',
    'SANTINO', 'SANTOS', 'SAUL', 'SEBASTIAN', 'SEGUNDO', 'SERGIO', 'SEVERO', 'SILVANO', 'SILVERIO', 'SILVIO',
    'SIMON', 'SIXTO', 'TADEO', 'TEODORO', 'THIAGO', 'TIAGO', 'TITO', 'TOBIAS', 'TOMAS', 'UBALDO',
    'ULISES', 'VALENTIN', 'VALENTINO', 'VALERIO', 'VICENTE', 'VICTOR', 'VICTORIO', 'VILMAR', 'WALDEMAR',
    'WALTER', 'WASHINGTON', 'WILFREDO', 'WILLIAMS', 'YAMIL'
]);

const FEMININE_NAMES = new Set([
    'ABRIL', 'ADA', 'ADELA', 'ADELAIDA', 'ADELINA', 'ADRIANA', 'AGATA', 'AGUSTINA', 'AIDA', 'ALBA',
    'ALDANA', 'ALEJANDRA', 'ALICIA', 'ALMA', 'ALONDRA', 'AMALIA', 'AMANDA', 'AMBAR', 'AMELIA', 'AMPARO',
    'ANA', 'ANABEL', 'ANABELLA', 'ANAHI', 'ANALIA', 'ANDREA', 'ANGELA', 'ANGELES', 'ANGELICA', 'ANITA',
    'ANTONELLA', 'ANTONIA', 'ARACELI', 'ARIADNA', 'ARIANA', 'ASTRID', 'AYELEN', 'AYLEN', 'AZUL', 'BARBARA',
    'BEATRIZ', 'BELEN', 'BERENICE', 'BERTHA', 'BETIANA', 'BETINA', 'BIANCA', 'BLANCA', 'BRENDA', 'BRIGIDA',
    'BRISA', 'CAMILA', 'CANDELA', 'CANDELARIA', 'CARIDAD', 'CARINA', 'CARLA', 'CARMELA', 'CARMEN', 'CAROLINA',
    'CATALINA', 'CECILIA', 'CESILIA', 'CELESTE', 'CELIA', 'CELINA', 'CINTIA', 'CINTHIA', 'CINTHYA', 'CLARA',
    'CLARISA', 'CLAUDIA', 'CLEMENCIA', 'CONSTANZA', 'CORA', 'CRISTINA', 'DAFNE', 'DAIANA', 'DAIRA', 'DALILA',
    'DALMA', 'DAMARIS', 'DANIELA', 'DAYANA', 'DEBORA', 'DELFINA', 'DELIA', 'DENISE', 'DIANA', 'DOLORES',
    'DOMINGA', 'DORA', 'DORIS', 'ELBA', 'ELENA', 'ELEONORA', 'ELIANA', 'ELISA', 'ELISABET', 'ELIZABET',
    'ELIZABETH', 'ELSA', 'ELVIRA', 'EMA', 'EMILIA', 'EMILSE', 'EMMA', 'ERICA', 'ERIKA', 'ERMELINDA',
    'ESTEFANIA', 'ESTELA', 'ESTER', 'ESTHER', 'EUGENIA', 'EULALIA', 'EVA', 'EVANGELINA', 'EVELYN', 'FABIANA',
    'FATIMA', 'FELICITAS', 'FLAVIA', 'FLOR', 'FLORENCIA', 'FRANCISCA', 'GABRIELA', 'GIANINA', 'GIANNA', 'GILDA',
    'GISELA', 'GISELLE', 'GIULIANA', 'GLADIS', 'GLADYS', 'GLORIA', 'GRACIELA', 'GRISELDA', 'GUADALUPE', 'GUILLERMINA',
    'HAYDEE', 'HEBE', 'HELENA', 'HERMINIA', 'HILDA', 'IGNACIA', 'INES', 'INGRID', 'IARA', 'IRENE',
    'IRIS', 'IRMA', 'ISABEL', 'ISABELA', 'ISABELLA', 'ISIDORA', 'IVANA', 'IVONNE', 'JACINTA', 'JAQUELINE',
    'JAZMIN', 'JENNIFER', 'JESICA', 'JESSICA', 'JIMENA', 'JOANA', 'JOHANA', 'JOHANNA', 'JOSEFA', 'JOSEFINA',
    'JUANA', 'JULIA', 'JULIANA', 'JULIETA', 'KAREN', 'KARINA', 'KATIA', 'LARA', 'LAURA', 'LEILA',
    'LEONOR', 'LETICIA', 'LIA', 'LIDIA', 'LILIAN', 'LILIANA', 'LINA', 'LORENA', 'LORENZA', 'LOURDES',
    'LUCIA', 'LUCIANA', 'LUCILA', 'LUCRECIA', 'LUDMILA', 'LUISA', 'LUNA', 'LUZ', 'MACARENA', 'MAGALI',
    'MAGDALENA', 'MAIRA', 'MAITE', 'MALENA', 'MANUELA', 'MARA', 'MARCELA', 'MARGARITA', 'MARIA', 'MARIANA',
    'MARIBEL', 'MARICEL', 'MARIEL', 'MARIELA', 'MARILINA', 'MARINA', 'MARISA', 'MARISOL', 'MARTA', 'MARTHA',
    'MATILDE', 'MAYRA', 'MELANI', 'MELANIE', 'MELINA', 'MELISA', 'MELISSA', 'MERCEDES', 'MIA', 'MICAELA',
    'MILAGROS', 'MIRIAM', 'MIRIAN', 'MIRTA', 'MIRTHA', 'MONICA', 'MORENA', 'MYRIAM', 'NADIA', 'NAIR',
    'NANCY', 'NATALIA', 'NATALIE', 'NELIDA', 'NERA', 'NILDA', 'NOELIA', 'NOEMI', 'NORA', 'NORMA',
    'OLGA', 'OLIVIA', 'PAMELA', 'PAOLA', 'PATRICIA', 'PAULA', 'PAULINA', 'PERLA', 'PILAR', 'PRISCILA',
    'RAMONA', 'RAQUEL', 'REBECA', 'REGINA', 'RITA', 'ROBERTA', 'ROCIO', 'ROMINA', 'ROSA', 'ROSALIA',
    'ROSANA', 'ROSARIO', 'ROXANA', 'RUBI', 'RUTH', 'SABRINA', 'SALOME', 'SAMANTA', 'SANDRA', 'SARA',
    'SARAH', 'SELVA', 'SILVANA', 'SILVIA', 'SILVINA', 'SOFIA', 'SOL', 'SOLEDAD', 'SONIA', 'SUSANA',
    'TAMARA', 'TANIA', 'TATIANA', 'TELMA', 'TERESA', 'VALENTINA', 'VALERIA', 'VANESA', 'VANESSA', 'VERONICA',
    'VICTORIA', 'VILMA', 'VIOLETA', 'VIRGINIA', 'VIVIANA', 'XIMENA', 'YAMILA', 'YANINA', 'YASMIN', 'YESICA',
    'YESSICA', 'YOLANDA', 'ZULEMA', 'ZUNILDA'
]);

const STOPWORDS = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'SAN', 'SANTA', 'Y', 'DA', 'DO', 'DOS', 'DI']);

/**
 * Infiere el género de una persona a partir de su nombre completo en formato habitual:
 * "APELLIDO(S) NOMBRE(S)" o "NOMBRE APELLIDO".
 * 
 * @param {string} nombreCompleto
 * @returns {{ genero: 'Masculino'|'Femenino'|'No determinado', confianza: 'alta'|'media'|'baja', nombre_detectado: string|null }}
 */
function inferirGeneroPorNombre(nombreCompleto) {
    if (!nombreCompleto || typeof nombreCompleto !== 'string') {
        return { genero: 'No determinado', confianza: 'baja', nombre_detectado: null };
    }

    // Normalizar: mayúsculas, quitar tildes y caracteres no alfabéticos
    const rawTokens = nombreCompleto
        .toUpperCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2);

    if (rawTokens.length === 0) {
        return { genero: 'No determinado', confianza: 'baja', nombre_detectado: null };
    }

    const tokens = rawTokens.filter(t => !STOPWORDS.has(t));

    // Si tiene 1 solo token
    if (tokens.length === 1) {
        const t = tokens[0];
        if (MASCULINE_NAMES.has(t)) return { genero: 'Masculino', confianza: 'media', nombre_detectado: t };
        if (FEMININE_NAMES.has(t)) return { genero: 'Femenino', confianza: 'media', nombre_detectado: t };
        return { genero: 'No determinado', confianza: 'baja', nombre_detectado: null };
    }

    // Formato común de CRM de seguros: APELLIDO [APELLIDO2] NOMBRE1 [NOMBRE2]
    // Buscamos coincidencias primero a partir del segundo token (i >= 1)
    let matchMasc = null;
    let matchFem = null;
    let idxMasc = -1;
    let idxFem = -1;

    for (let i = 1; i < tokens.length; i++) {
        const t = tokens[i];
        if (!matchFem && FEMININE_NAMES.has(t)) {
            matchFem = t;
            idxFem = i;
        }
        if (!matchMasc && MASCULINE_NAMES.has(t)) {
            matchMasc = t;
            idxMasc = i;
        }
    }

    // Si no encontramos nada después del primer token, inspeccionar el primer token (formato Nombre Apellido)
    if (!matchMasc && !matchFem) {
        const t = tokens[0];
        if (FEMININE_NAMES.has(t)) {
            matchFem = t;
            idxFem = 0;
        } else if (MASCULINE_NAMES.has(t)) {
            matchMasc = t;
            idxMasc = 0;
        }
    }

    // Si encontramos ambos tokens (caso compuesto, ej. MARIA JOSE o JOSE MARIA):
    if (matchMasc && matchFem) {
        if (idxFem < idxMasc && tokens[idxFem] === 'MARIA' && tokens[idxMasc] === 'JOSE') {
            return { genero: 'Femenino', confianza: 'alta', nombre_detectado: 'MARIA JOSE' };
        }
        if (idxMasc < idxFem && tokens[idxMasc] === 'JOSE' && tokens[idxFem] === 'MARIA') {
            return { genero: 'Masculino', confianza: 'alta', nombre_detectado: 'JOSE MARIA' };
        }
        if (idxMasc < idxFem && tokens[idxMasc] === 'JUAN' && tokens[idxFem] === 'MARIA') {
            return { genero: 'Masculino', confianza: 'alta', nombre_detectado: 'JUAN MARIA' };
        }
        // Regla general de nombres compuestos en español: el primer nombre de pila manda
        if (idxFem < idxMasc) {
            return { genero: 'Femenino', confianza: 'media', nombre_detectado: matchFem };
        }
        return { genero: 'Masculino', confianza: 'media', nombre_detectado: matchMasc };
    }

    if (matchMasc) return { genero: 'Masculino', confianza: 'alta', nombre_detectado: matchMasc };
    if (matchFem) return { genero: 'Femenino', confianza: 'alta', nombre_detectado: matchFem };

    return { genero: 'No determinado', confianza: 'baja', nombre_detectado: null };
}

/**
 * Calcula agregación demográfica de género y cobertura de DNI
 * sobre una lista de pólizas/clientes activos.
 * 
 * @param {Array<{ nombre?: string, cliente_nombre?: string, dni?: string, cliente_dni?: string }>} items
 * @returns {object}
 */
function calcularEstadisticasDemograficas(items = []) {
    let masc = 0;
    let fem = 0;
    let noDet = 0;
    let conDni = 0;

    for (const item of items) {
        const nombre = item.cliente_nombre || item.nombre || '';
        const dni = item.cliente_dni || item.dni || '';

        if (dni && String(dni).trim().length >= 7) {
            conDni++;
        }

        const inf = inferirGeneroPorNombre(nombre);
        if (inf.genero === 'Masculino') masc++;
        else if (inf.genero === 'Femenino') fem++;
        else noDet++;
    }

    const total = items.length;
    const pctMasc = total > 0 ? parseFloat(((masc / total) * 100).toFixed(1)) : 0;
    const pctFem = total > 0 ? parseFloat(((fem / total) * 100).toFixed(1)) : 0;
    const pctNoDet = total > 0 ? parseFloat(((noDet / total) * 100).toFixed(1)) : 0;
    const pctConDni = total > 0 ? parseFloat(((conDni / total) * 100).toFixed(1)) : 0;

    return {
        total_analizados: total,
        masculino: masc,
        femenino: fem,
        no_determinado: noDet,
        pct_masculino: pctMasc,
        pct_femenino: pctFem,
        pct_no_determinado: pctNoDet,
        con_dni: conDni,
        pct_con_dni: pctConDni,
        estadistica_edad_disponible: false,
        motivo_edad_pausada: 'En pausa metodológica hasta contar con fecha de nacimiento real verificada. En Argentina la numeración de DNI no correlaciona linealmente con la edad por duplicados históricos y naturalizaciones.',
        aclaracion_metodologica: 'Inferencia algorítmica estimada por nombre de pila sobre la cartera activa viva. Estimación orientativa interna, no constituye dato registral oficial ni contractual.'
    };
}

module.exports = {
    MASCULINE_NAMES,
    FEMININE_NAMES,
    inferirGeneroPorNombre,
    calcularEstadisticasDemograficas
};
